// SPDX-License-Identifier: GPL-3.0-only
package app.tellyscope.cursor;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;

/**
 * The mouse pointer on the TV. Android draws no cursor for the mouse events Tellyscope's key helper
 * injects, so this draws one: an arrow in a window over everything, which can't be touched or take
 * focus. The helper connects to port {@value #PORT} on this TV and writes one line per move,
 * {@code x y} in screen pixels (the arrow's tip), or {@code h} to hide it. It hides itself after a
 * few quiet seconds and when the helper's connection ends. Needs the "display over other apps"
 * permission, which Tellyscope grants through ADB.
 */
public final class CursorService extends Service {
    static final int PORT = 47831;
    private static final String CHANNEL = "pointer";
    private static final long IDLE_HIDE_MS = 6_000;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private WindowManager windows;
    private WindowManager.LayoutParams params;
    private View arrow;
    private boolean started;

    private final Runnable hide = () -> {
        if (arrow != null) arrow.setVisibility(View.GONE);
    };

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        // A foreground service must say so every time it is started this way.
        startForeground(1, notification());
        if (!started) {
            started = true;
            try {
                addArrow();
            } catch (Throwable t) {
                // No permission to draw over other apps: nothing to show.
                stopSelf();
                return START_NOT_STICKY;
            }
            new Thread(this::listen, "pointer-listen").start();
        }
        return START_NOT_STICKY;
    }

    private Notification notification() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Pointer", NotificationManager.IMPORTANCE_MIN));
        return new Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle("Tellyscope pointer")
            .build();
    }

    private void addArrow() {
        float density = getResources().getDisplayMetrics().density;
        int size = Math.round(28 * density);
        windows = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
        arrow = new Arrow(this, density);
        arrow.setVisibility(View.GONE);
        params = new WindowManager.LayoutParams(
            size, size,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.TOP | Gravity.LEFT;
        // Android 12+ drops touches that pass through another app's overlay more opaque than 0.8, and the
        // arrow always sits where the click lands, so it stays under that.
        params.alpha = 0.75f;
        windows.addView(arrow, params);
    }

    /** One helper at a time, over and over: a new connection each time the Remote opens. */
    private void listen() {
        try (ServerSocket server = new ServerSocket()) {
            server.setReuseAddress(true);
            server.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), PORT));
            while (true) {
                try (Socket client = server.accept();
                     BufferedReader in = new BufferedReader(new InputStreamReader(client.getInputStream(), "UTF-8"))) {
                    for (String line; (line = in.readLine()) != null; ) handle(line);
                } catch (Exception e) {
                    // This connection ended; wait for the next.
                }
                ui.post(hide);
            }
        } catch (Exception e) {
            // Port taken by an earlier run of this service, which is serving already.
        }
    }

    private void handle(String line) {
        if (line.equals("h")) {
            ui.post(hide);
            return;
        }
        String[] p = line.trim().split(" ");
        if (p.length != 2) return;
        final int x;
        final int y;
        try {
            x = Integer.parseInt(p[0]);
            y = Integer.parseInt(p[1]);
        } catch (NumberFormatException e) {
            return;
        }
        ui.post(() -> {
            if (arrow == null) return;
            params.x = x;
            params.y = y;
            try {
                windows.updateViewLayout(arrow, params);
            } catch (Throwable t) {
                return;
            }
            arrow.setVisibility(View.VISIBLE);
            ui.removeCallbacks(hide);
            ui.postDelayed(hide, IDLE_HIDE_MS);
        });
    }

    @Override public void onDestroy() {
        ui.removeCallbacksAndMessages(null);
        if (arrow != null) {
            try {
                windows.removeView(arrow);
            } catch (Throwable t) {
                // Already gone.
            }
        }
        super.onDestroy();
    }

    /** A white arrow with a dark edge, its tip at the view's top left. */
    private static final class Arrow extends View {
        private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint edge = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Path path = new Path();

        Arrow(Context context, float density) {
            super(context);
            fill.setColor(0xFFFFFFFF);
            fill.setStyle(Paint.Style.FILL);
            edge.setColor(0xFF000000);
            edge.setStyle(Paint.Style.STROKE);
            edge.setStrokeWidth(1.5f * density);
            edge.setStrokeJoin(Paint.Join.ROUND);
        }

        @Override protected void onDraw(Canvas canvas) {
            float w = getWidth() - 2f;
            float h = getHeight() - 2f;
            path.reset();
            path.moveTo(1, 1);
            path.lineTo(1, h * 0.85f);
            path.lineTo(w * 0.22f, h * 0.66f);
            path.lineTo(w * 0.40f, h);
            path.lineTo(w * 0.54f, h * 0.93f);
            path.lineTo(w * 0.37f, h * 0.61f);
            path.lineTo(w * 0.66f, h * 0.61f);
            path.close();
            canvas.drawPath(path, fill);
            canvas.drawPath(path, edge);
        }
    }
}
