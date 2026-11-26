@{
    App = @(
        'ComfyBridge.exe', 'Microsoft.Web.WebView2.Core.dll',
        'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll', 'WebView2-LICENSE.txt',
        'worker.py', 'workflows.py', 'extension.py', 'handoff.py', 'cancel_recovery.py',
        'gpu_handoff.py', 'media_index.py', 'progress.py', 'queue_progress.py', 'queue_eta.py',
        'studio.py', 'recipes.py', 'provenance.py', 'chat.py', 'quick_edit.py', 'model_library.py',
        'model_gallery.py', 'model_downloads.py', 'civitai_browser.py', 'feed_bank.py',
        'social_outbox.py', 'browse_replica.py', 'civitai_requests.py', 'api_debug.py', 'install_chat.py',
        'image_models.py', 'setup_krea2.py', 'Setup-Chat.ps1', 'Setup-Remacri.ps1'
    )
    Setup = @('Install.ps1', 'WindowsFiles.psd1', 'config.json', 'AllowNetwork.ps1',
              'comfybridge_eros_vsa.py', 'comfybridge_checkpoint.py')
}
