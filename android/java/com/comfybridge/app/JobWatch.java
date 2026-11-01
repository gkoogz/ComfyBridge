package com.comfybridge.app;

import android.app.*;
import android.app.job.*;
import android.content.*;
import android.os.*;
import org.json.*;
import java.net.*;
import java.util.*;
import java.util.concurrent.*;

/** Runs only while this installation has submitted batches to watch. */
public class JobWatch extends Service {
 static final int LIVE=3901,RETRY=3902;
 static final String PROGRESS="job-progress",FINISHED="job-finished";
 ScheduledExecutorService loop;
 static SharedPreferences prefs(Context c){return c.getSharedPreferences("connection",MODE_PRIVATE);}
 static String key(Context c){return "watch:"+prefs(c).getString("fingerprint","");}
 static synchronized Set<String> watched(Context c){return new HashSet<>(prefs(c).getStringSet(key(c),Collections.emptySet()));}
 static synchronized void track(Context c,String id){Set<String>s=watched(c);s.add(id);prefs(c).edit().putStringSet(key(c),s).commit();schedule(c);}
 static synchronized void done(Context c,String id){Set<String>s=watched(c);s.remove(id);prefs(c).edit().putStringSet(key(c),s).commit();}
 static boolean allowed(Context c){return c.getSystemService(NotificationManager.class).areNotificationsEnabled()&&(Build.VERSION.SDK_INT<33||c.checkSelfPermission("android.permission.POST_NOTIFICATIONS")==0);}
 static void channels(Context c){NotificationManager m=c.getSystemService(NotificationManager.class);m.createNotificationChannel(new NotificationChannel(PROGRESS,"Generation progress",NotificationManager.IMPORTANCE_LOW));m.createNotificationChannel(new NotificationChannel(FINISHED,"Finished generations",NotificationManager.IMPORTANCE_DEFAULT));}
 static void resume(Context c){if(!watched(c).isEmpty()&&allowed(c)){try{c.startForegroundService(new Intent(c,JobWatch.class));}catch(IllegalStateException e){schedule(c);}}}
 static void schedule(Context c){c.getSystemService(JobScheduler.class).schedule(new JobInfo.Builder(RETRY,new ComponentName(c,Retry.class)).setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setMinimumLatency(60000).setPersisted(true).build());}
 static Notification notice(Context c,String channel,String title,String text,int pct){
  boolean finished=channel.equals(FINISHED);
  Intent i=new Intent(c,MainActivity.class).putExtra("view",finished?"library":"queue").addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP|Intent.FLAG_ACTIVITY_CLEAR_TOP);
  Notification.Builder b=new Notification.Builder(c,channel).setSmallIcon(android.R.drawable.ic_media_play).setContentTitle(title).setContentText(text).setContentIntent(PendingIntent.getActivity(c,finished?2:1,i,PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT));
  if(channel.equals(PROGRESS))b.setOnlyAlertOnce(true).setOngoing(true).setProgress(100,Math.max(0,pct),pct<0);else b.setAutoCancel(true);
  return b.build();
 }
 static final Semaphore polling=new Semaphore(1);
 static boolean poll(Context c)throws Exception{if(!polling.tryAcquire())return true;try{return check(c);}finally{polling.release();}}
 static boolean check(Context c)throws Exception{
  NotificationManager m=c.getSystemService(NotificationManager.class);String live=null;int pct=-1,nActive=0;
  String scope=key(c);for(String batch:watched(c)){
   HttpURLConnection conn=MainActivity.connection(prefs(c),"api/batch/"+batch,"GET");conn.setReadTimeout(15000);JSONArray jobs;
   try{if(conn.getResponseCode()!=200)throw new java.io.IOException("PC unavailable");jobs=new JSONObject(MainActivity.read(conn.getInputStream())).getJSONArray("jobs");}finally{conn.disconnect();}
   if(!scope.equals(key(c)))return !watched(c).isEmpty();
   if(jobs.length()==0){done(c,batch);continue;}
   int complete=0,error=0,cancelled=0;double sum=0;JSONObject current=null;
   for(int i=0;i<jobs.length();i++){JSONObject j=jobs.getJSONObject(i);String status=j.getString("status");
    if(status.equals("complete")){complete++;sum++;}else if(status.equals("error"))error++;else if(status.equals("cancelled"))cancelled++;
    else{sum+=j.optDouble("progress",0);if(current==null||status.equals("running"))current=j;}
   }
   String kind=jobs.getJSONObject(0).getString("kind");
   if(current==null){String summary=complete+" saved"+(error>0?", "+error+" failed":"")+(cancelled>0?", "+cancelled+" cancelled":"");
    m.notify(batch,1,notice(c,FINISHED,"ComfyBridge · "+kind+" batch finished",summary,-1));done(c,batch);
   }else{nActive++;if(live==null||current.getString("status").equals("running")){pct=Math.min(99,(int)Math.round(100*sum/jobs.length()));String stage=current.optString("current_node","");live=kind+" "+current.getInt("ordinal")+"/"+jobs.length()+" · "+(stage.isEmpty()?current.getString("status"):stage);}}
  }
  if(live!=null)m.notify(LIVE,notice(c,PROGRESS,"ComfyBridge · "+pct+"%"+(nActive>1?" · "+nActive+" batches":""),live,pct));
  return !watched(c).isEmpty();
 }
 @Override public int onStartCommand(Intent i,int flags,int id){
  channels(this);startForeground(LIVE,notice(this,PROGRESS,"ComfyBridge","Checking PC queue…",-1));
  if(loop==null){loop=Executors.newSingleThreadScheduledExecutor();loop.scheduleWithFixedDelay(()->{
   try{if(!poll(this)){stopForeground(STOP_FOREGROUND_REMOVE);stopSelf();}}
   catch(Exception e){getSystemService(NotificationManager.class).notify(LIVE,notice(this,PROGRESS,"Waiting for PC","Accepted jobs continue. Reconnecting…",-1));}
  },0,4,TimeUnit.SECONDS);}
  return START_STICKY;
 }
 @Override public void onTimeout(int id,int type){schedule(this);stopForeground(STOP_FOREGROUND_REMOVE);stopSelf();}
 @Override public void onDestroy(){if(loop!=null)loop.shutdownNow();super.onDestroy();}
 @Override public IBinder onBind(Intent i){return null;}
 public static class Retry extends JobService{
  @Override public boolean onStartJob(JobParameters p){new Thread(()->{boolean more=true;try{channels(this);more=allowed(this)&&poll(this);}catch(Exception ignored){}if(!more)getSystemService(NotificationManager.class).cancel(LIVE);jobFinished(p,more);}).start();return true;}
  @Override public boolean onStopJob(JobParameters p){return true;}
 }
}
