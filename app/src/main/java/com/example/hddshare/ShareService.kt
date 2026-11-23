package com.example.hddshare

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.wifi.WifiManager
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import fi.iki.elonen.NanoHTTPD

/**
 * Hafif bir bekçi servisi: açılışta başlar, USB disk var mı diye bakar.
 * Disk VARSA HTTP/WebDAV sunucusunu açar, disk YOKSA sunucu kapalı kalır (port dinlenmez).
 * Disk çıkarılınca sunucu kapanır, tekrar takılınca kendiliğinden açılır.
 */
class ShareService : Service() {
    private var thread: HandlerThread? = null
    private var handler: Handler? = null
    private var server: FileServer? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var lastText: String? = null
    @Volatile private var running = false

    private val tick = object : Runnable {
        override fun run() {
            if (!running) return
            try {
                syncServer()
            } catch (e: Exception) {
                Log.e(TAG, "Kontrol hatası", e)
            }
            handler?.postDelayed(this, Config.CHECK_INTERVAL_MS)
        }
    }

    private val mediaReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            // Takma/çıkarma olayında hemen kontrol et (kısa gecikme: mount bitsin)
            handler?.removeCallbacks(tick)
            handler?.postDelayed(tick, 1000)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIF_ID, buildNotification(lastText ?: "Disk bekleniyor"))

        if (!running) {
            running = true
            val t = HandlerThread("hddshare-watch")
            t.start()
            thread = t
            val h = Handler(t.looper)
            handler = h

            val f = IntentFilter().apply {
                addAction(Intent.ACTION_MEDIA_MOUNTED)
                addAction(Intent.ACTION_MEDIA_UNMOUNTED)
                addAction(Intent.ACTION_MEDIA_EJECT)
                addAction(Intent.ACTION_MEDIA_REMOVED)
                addAction(Intent.ACTION_MEDIA_BAD_REMOVAL)
                addDataScheme("file")
            }
            registerReceiver(mediaReceiver, f)
            h.post(tick)
        }
        return START_STICKY
    }

    @Synchronized
    private fun syncServer() {
        val hasDisk = Volumes.list(applicationContext).isNotEmpty()
        if (hasDisk && server == null) startServer()
        else if (!hasDisk && server != null) stopServer()
        updateNotification()
    }

    @Synchronized
    private fun startServer() {
        try {
            val s = FileServer(applicationContext)
            s.start(NanoHTTPD.SOCKET_READ_TIMEOUT, false)
            server = s
        } catch (e: Exception) {
            // Port meşgul olabilir; bir sonraki kontrolde tekrar denenecek
            Log.e(TAG, "Sunucu başlatılamadı", e)
            return
        }

        if (wifiLock == null) {
            val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL, "hddshare:wifi").apply {
                setReferenceCounted(false)
            }
        }
        wifiLock?.let { if (!it.isHeld) it.acquire() }

        if (Config.KEEP_CPU_AWAKE) {
            if (wakeLock == null) {
                val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "hddshare:cpu").apply {
                    setReferenceCounted(false)
                }
            }
            wakeLock?.let { if (!it.isHeld) it.acquire() }
        }
    }

    @Synchronized
    private fun stopServer() {
        try { server?.stop() } catch (e: Exception) { Log.e(TAG, "Durdurma hatası", e) }
        server = null
        wifiLock?.let { if (it.isHeld) it.release() }
        wakeLock?.let { if (it.isHeld) it.release() }
    }

    private fun updateNotification() {
        val text = if (server != null) "Paylaşım açık - port ${Config.PORT}" else "Disk bekleniyor"
        if (text == lastText) return
        lastText = text
        getSystemService(NotificationManager::class.java).notify(NOTIF_ID, buildNotification(text))
    }

    private fun buildNotification(text: String): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel("share", "HDD Paylaşım", NotificationManager.IMPORTANCE_MIN)
        )
        return Notification.Builder(this, "share")
            .setContentTitle("HDD Paylaş")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_share)
            .build()
    }

    override fun onDestroy() {
        running = false
        try { unregisterReceiver(mediaReceiver) } catch (_: Exception) {}
        handler?.removeCallbacksAndMessages(null)
        stopServer()
        thread?.quitSafely()
        thread = null
        handler = null
        super.onDestroy()
    }

    companion object {
        private const val TAG = "HDDShare"
        private const val NOTIF_ID = 1
    }
}
