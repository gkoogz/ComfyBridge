package com.comfybridge.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.SystemClock;
import android.widget.Toast;
import java.io.InputStream;
import java.net.URL;
import java.util.concurrent.Executor;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONArray;
import org.json.JSONObject;

final class ReleaseUpdates {
    private static final String API = "https://api.github.com/repos/gkoogz/ComfyBridge/releases";
    private static final String DOWNLOAD = "https://github.com/gkoogz/ComfyBridge/releases/download/v";
    private static final Pattern VERSION = Pattern.compile("(\\d+)\\.(\\d+)\\.(\\d+)(?:-(alpha|beta|rc)\\.(\\d+))?");
    private long lastCheck = -1;
    private boolean checking, resumed;
    private String pending, offered;

    static int[] parts(String version) {
        Matcher m = VERSION.matcher(version);
        if (!m.matches()) return null;
        String channel = m.group(4);
        int rank = channel == null ? 3 : channel.equals("rc") ? 2 : channel.equals("beta") ? 1 : 0;
        try {
            return new int[]{Integer.parseInt(m.group(1)), Integer.parseInt(m.group(2)), Integer.parseInt(m.group(3)),
                    rank, channel == null ? 0 : Integer.parseInt(m.group(5))};
        } catch (NumberFormatException ignored) { return null; }
    }

    static boolean newer(String candidate, String current) {
        int[] a = parts(candidate), b = parts(current);
        if (a == null || b == null) return false;
        for (int i=0; i<a.length; i++) if (a[i] != b[i]) return a[i] > b[i];
        return false;
    }

    static String select(JSONArray releases, String best) {
        for (int i=0; i<releases.length(); i++) {
            JSONObject release = releases.optJSONObject(i);
            if (release == null || release.optBoolean("draft",true)) continue;
            String tag = release.optString("tag_name","");
            if (!tag.startsWith("v") || !newer(tag.substring(1), best)) continue;
            String version = tag.substring(1), file = filename(version);
            JSONArray assets = release.optJSONArray("assets");
            if (assets == null) continue;
            for (int j=0; j<assets.length(); j++) {
                JSONObject asset = assets.optJSONObject(j);
                if (asset != null && file.equals(asset.optString("name")) &&
                        "uploaded".equals(asset.optString("state")) && asset.optLong("size")>0) {
                    best = version;
                    break;
                }
            }
        }
        return best;
    }

    private static String filename(String version) { return "ComfyBridge-"+version+".apk"; }

    static String lookup(String installed) throws Exception {
        String best = installed;
        for (int page=1;;page++) {
            HttpsURLConnection c = (HttpsURLConnection)new URL(API+"?per_page=100&page="+page).openConnection();
            c.setConnectTimeout(5000); c.setReadTimeout(7000);
            c.setRequestProperty("User-Agent","ComfyBridge-Android/"+installed);
            c.setRequestProperty("Accept","application/vnd.github+json");
            try {
                if (c.getResponseCode()!=200) return best;
                try (InputStream in=c.getInputStream()) {
                    JSONArray rows=new JSONArray(MainActivity.read(in));
                    best=select(rows,best);
                    if (rows.length()<100) return best;
                }
            } finally { c.disconnect(); }
        }
    }

    void foreground(Activity activity, Executor executor) {
        resumed=true;
        offer(activity);
        long now=SystemClock.elapsedRealtime();
        if (checking || (lastCheck>=0 && now-lastCheck<300000)) return;
        checking=true; lastCheck=now;
        executor.execute(()->{
            String result=null;
            try {
                String installed=activity.getPackageManager().getPackageInfo(activity.getPackageName(),0).versionName;
                String best=lookup(installed);
                if (newer(best,installed)) result=best;
            } catch (Exception ignored) { /* GitHub being unavailable doesn't affect the bridge. */ }
            final String update=result;
            activity.runOnUiThread(()->{checking=false;pending=update;offer(activity);});
        });
    }

    void background() { resumed=false; }

    private void offer(Activity activity) {
        if (!resumed || pending==null || pending.equals(offered) || activity.isFinishing() || activity.isDestroyed()) return;
        final String version=pending;
        offered=version;
        new AlertDialog.Builder(activity)
            .setTitle("ComfyBridge update available")
            .setMessage("Version "+version+" is available on GitHub. Download the APK and open it to update this app.")
            .setNegativeButton("Later",null)
            .setPositiveButton("Download APK",(dialog,button)->{
                Uri url=Uri.parse(DOWNLOAD+version+"/"+filename(version));
                try { activity.startActivity(new Intent(Intent.ACTION_VIEW,url)); }
                catch (ActivityNotFoundException e) { Toast.makeText(activity,"No browser available to open GitHub.",Toast.LENGTH_LONG).show(); }
            }).show();
    }
}
