// SPDX-License-Identifier: GPL-3.0-only
package app.tellyscope.helper;

import android.content.ClipData;
import android.os.Build;
import android.os.IBinder;
import android.graphics.Point;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.InputEvent;
import android.view.KeyCharacterMap;
import android.view.KeyEvent;
import android.view.MotionEvent;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.lang.reflect.Method;

/**
 * The remote's key sender. Runs on the TV as the shell user, through {@code app_process}, and stays
 * up for as long as the remote is open: {@code input keyevent} starts a fresh VM for every key,
 * which is most of a second on a slow TV. Reads one Android key code per line on stdin, injects a
 * press and release the way {@code input} does, and answers {@code 1} when the TV took both or
 * {@code 0} when it didn't. Prints {@code ready} first. Only key codes are read, so nothing typed
 * reaches a shell. The argument is the jar's own path, deleted once the helper is up; it exits at
 * the end of stdin. A line starting with {@code t} is text instead: the rest is typed the way
 * {@code input text} types it, one key press per character, or pasted when it holds a character
 * the keymap has no key for (Cyrillic, Arabic). {@code v} and a signed count moves the
 * media volume that many steps in one set, with the TV's volume bar, or by one key press where a set
 * can't move it; {@code 0} means neither worked, and the caller presses the keys instead.
 * {@code p0} turns the TV's picture off and {@code p2} back on, through SurfaceFlinger: the TV stays
 * awake, so ADB stays connected, and the picture stays off after the helper exits.
 * {@code m} is the mouse: {@code mm<dx>,<dy>} moves the pointer that far, {@code mc} clicks where it is
 * and {@code ms<n>} turns the wheel {@code n} notches (negative is down). The pointer's place is kept
 * here, starting in the middle of the screen, and the events are sent as a mouse's.
 */
public final class Keys {
    /** InputManager's INJECT_INPUT_EVENT_MODE_WAIT_FOR_FINISH: answers once the focused app is done with it. */
    private static final int WAIT_FOR_FINISH = 2;
    /** AudioManager.STREAM_MUSIC and FLAG_SHOW_UI. */
    private static final int STREAM_MUSIC = 3;
    private static final int FLAG_SHOW_UI = 1;

    private static final int ASYNC = 0;
    private static float mouseX, mouseY;
    private static int screenW = 1920, screenH = 1080;
    private static boolean sized;

    public static void main(String[] args) throws Exception {
        Object manager;
        Method inject;
        try {
            // Android 14 moved injection to InputManagerGlobal; older builds have it on InputManager.
            Class<?> global = Class.forName("android.hardware.input.InputManagerGlobal");
            manager = global.getDeclaredMethod("getInstance").invoke(null);
            inject = global.getMethod("injectInputEvent", InputEvent.class, int.class);
        } catch (ClassNotFoundException e) {
            Class<?> im = Class.forName("android.hardware.input.InputManager");
            manager = im.getDeclaredMethod("getInstance").invoke(null);
            inject = im.getMethod("injectInputEvent", InputEvent.class, int.class);
        }
        if (args.length == 1) new File(args[0]).delete();

        PrintStream out = new PrintStream(System.out, false, "UTF-8");
        out.print("ready\n");
        out.flush();
        KeyCharacterMap keymap = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD);
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, "UTF-8"));
        for (String line; (line = in.readLine()) != null; ) {
            boolean ok;
            try {
                if (line.startsWith("p")) {
                    out.print(power(Integer.parseInt(line.substring(1).trim())) ? "1\n" : "0\n");
                    out.flush();
                    continue;
                }
                if (line.startsWith("v")) {
                    out.print(volume(manager, inject, Integer.parseInt(line.substring(1).trim())) ? "1\n" : "0\n");
                    out.flush();
                    continue;
                }
                if (line.startsWith("m")) {
                    out.print(mouse(manager, inject, line.substring(1)) ? "1\n" : "0\n");
                    out.flush();
                    continue;
                }
                if (line.startsWith("t")) {
                    out.print(type(manager, inject, keymap, line.substring(1)) ? "1\n" : "0\n");
                    out.flush();
                    continue;
                }
                int code = Integer.parseInt(line.trim());
                long now = SystemClock.uptimeMillis();
                ok = send(manager, inject, now, KeyEvent.ACTION_DOWN, code, 0)
                    && send(manager, inject, now, KeyEvent.ACTION_UP, code, 0);
            } catch (Throwable t) {
                ok = false;
            }
            out.print(ok ? "1\n" : "0\n");
            out.flush();
        }
        if (overlayOn) overlay(false, true);
        cursorClose();
    }

    private static boolean overlayOn;

    /** The pointer app's port on this TV, and the connection to it, opened on the first move. */
    private static final int CURSOR_PORT = 47831;
    private static java.net.Socket cursorSocket;
    private static java.io.OutputStream cursorOut;
    private static long cursorTried;

    /**
     * Tells the pointer app one line: {@code x y} or {@code h}. It may not be up yet (it starts when the
     * mouse is first used), so a failed connect is tried again after a moment; the mouse works without it.
     */
    private static void cursor(String line) {
        try {
            if (cursorOut == null) {
                long now = SystemClock.uptimeMillis();
                if (cursorTried != 0 && now - cursorTried < 1500) return;
                cursorTried = now;
                java.net.Socket s = new java.net.Socket();
                s.connect(new java.net.InetSocketAddress("127.0.0.1", CURSOR_PORT), 150);
                s.setTcpNoDelay(true);
                cursorSocket = s;
                cursorOut = s.getOutputStream();
            }
            cursorOut.write((line + "\n").getBytes("UTF-8"));
            cursorOut.flush();
        } catch (Throwable t) {
            cursorClose();
        }
    }

    private static void cursorClose() {
        try {
            if (cursorSocket != null) cursorSocket.close();
        } catch (Throwable t) {
            // Gone already.
        }
        cursorSocket = null;
        cursorOut = null;
    }

    /**
     * Android's own Pointer location overlay (a crosshair and the pointer's numbers), the one pointer
     * a TV draws for injected mouse events, which have no cursor. Turned on with the mouse's first
     * move and off with {@code mo} or when the helper ends. Waits for the settings command only when
     * [wait]; the first move shouldn't.
     */
    private static void overlay(boolean on, boolean wait) {
        overlayOn = on;
        Runnable run = () -> {
            try {
                new ProcessBuilder("settings", "put", "system", "pointer_location", on ? "1" : "0").start().waitFor();
            } catch (Throwable t) {
                // The mouse works without it.
            }
        };
        if (wait) run.run(); else new Thread(run).start();
    }

    /**
     * SurfaceControl's display power mode: 0 is off, 2 is on. Android 10 to 13 name the display by
     * getInternalDisplayToken, older builds by getBuiltInDisplay(0). Android 14 moved both to a
     * class the shell's VM can't load, so there it answers 0.
     */
    private static boolean power(int mode) {
        try {
            Class<?> sc = Class.forName("android.view.SurfaceControl");
            Object display;
            try {
                display = sc.getMethod("getInternalDisplayToken").invoke(null);
            } catch (NoSuchMethodException e) {
                display = sc.getMethod("getBuiltInDisplay", int.class).invoke(null, 0);
            }
            if (display == null) return false;
            sc.getMethod("setDisplayPowerMode", IBinder.class, int.class).invoke(null, display, mode);
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * Sets the media volume {@code delta} steps from where it is, kept inside the range, through
     * IAudioService as the shell, and reads it back. Where the set can't move it, one Volume key
     * goes instead: already at the end (the key shows the bar), or an output whose volume is held
     * at full. That is a fixed output, or a box with HDMI-CEC, where AOSP drops the set and turns
     * each key into one CEC press to the TV, so a tap is one step of the TV's own volume. False when
     * the volume can't be read or set at all; the caller then presses the keys.
     */
    private static boolean volume(Object manager, Method inject, int delta) throws Exception {
        boolean moved;
        try {
            IBinder binder = (IBinder) Class.forName("android.os.ServiceManager")
                .getMethod("getService", String.class).invoke(null, "audio");
            if (binder == null) return false;
            Object audio = Class.forName("android.media.IAudioService$Stub")
                .getMethod("asInterface", IBinder.class).invoke(null, binder);
            Method get = audio.getClass().getMethod("getStreamVolume", int.class);
            int now = (Integer) get.invoke(audio, STREAM_MUSIC);
            int max = (Integer) audio.getClass().getMethod("getStreamMaxVolume", int.class).invoke(audio, STREAM_MUSIC);
            int target = Math.max(0, Math.min(max, now + delta));
            if (target == now) {
                moved = false;
            } else {
                if (!setVolume(audio, target)) return false;
                moved = (Integer) get.invoke(audio, STREAM_MUSIC) != now;
            }
        } catch (Throwable t) {
            return false;
        }
        if (moved) return true;
        int code = delta > 0 ? KeyEvent.KEYCODE_VOLUME_UP : KeyEvent.KEYCODE_VOLUME_DOWN;
        long down = SystemClock.uptimeMillis();
        return send(manager, inject, down, KeyEvent.ACTION_DOWN, code, 0)
            && send(manager, inject, down, KeyEvent.ACTION_UP, code, 0);
    }

    /**
     * IAudioService.setStreamVolume(stream, index, flags, package), which Android 13 also has as
     * setStreamVolumeWithAttribution with a tag after the package. Called as {@code com.android.shell}
     * with a null tag, and FLAG_SHOW_UI so the TV shows its volume bar.
     */
    private static boolean setVolume(Object audio, int index) throws Exception {
        for (Method m : audio.getClass().getMethods()) {
            if (!m.getName().equals("setStreamVolume") && !m.getName().equals("setStreamVolumeWithAttribution")) continue;
            Class<?>[] types = m.getParameterTypes();
            if (types.length < 4 || types[0] != int.class || types[1] != int.class || types[2] != int.class) continue;
            Object[] args = new Object[types.length];
            args[0] = STREAM_MUSIC;
            args[1] = index;
            args[2] = FLAG_SHOW_UI;
            boolean ok = true;
            for (int i = 3; i < types.length; i++) {
                if (types[i] != String.class) { ok = false; break; }
                args[i] = i == 3 ? "com.android.shell" : null;
            }
            if (!ok) continue;
            m.invoke(audio, args);
            return true;
        }
        return false;
    }

    /** Null from getEvents means a character the keymap has no key for: that text is pasted. */
    private static boolean type(Object manager, Method inject, KeyCharacterMap keymap, String text) {
        try {
            KeyEvent[] events = keymap.getEvents(text.toCharArray());
            if (events == null) return paste(manager, inject, text);
            for (KeyEvent e : events) {
                KeyEvent now = KeyEvent.changeTimeRepeat(e, SystemClock.uptimeMillis(), 0);
                now.setSource(InputDevice.SOURCE_KEYBOARD);
                if (!(Boolean) inject.invoke(manager, now, WAIT_FOR_FINISH)) return false;
            }
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * Puts {@code text} on the TV's clipboard as the shell, then presses Paste in the focused box. The
     * keymap only has keys for Latin, so this is the one way to non-Latin text without an input
     * method on the TV. It replaces whatever the TV's clipboard held. Paste is its own key from
     * Android 7; older text boxes take Ctrl+V.
     */
    private static boolean paste(Object manager, Method inject, String text) throws Exception {
        if (!setClip(ClipData.newPlainText(null, text))) return false;
        long now = SystemClock.uptimeMillis();
        if (Build.VERSION.SDK_INT >= 24) {
            return send(manager, inject, now, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_PASTE, 0)
                && send(manager, inject, now, KeyEvent.ACTION_UP, KeyEvent.KEYCODE_PASTE, 0);
        }
        int ctrl = KeyEvent.META_CTRL_ON | KeyEvent.META_CTRL_LEFT_ON;
        return send(manager, inject, now, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_V, ctrl)
            && send(manager, inject, now, KeyEvent.ACTION_UP, KeyEvent.KEYCODE_V, ctrl);
    }

    /**
     * IClipboard.setPrimaryClip, called as {@code com.android.shell} for user 0. Its arguments grew
     * over the years: (clip, package) before Android 10, then a user id, then on 13 an attribution
     * tag before it, then on 14 a device id after it. Each is filled by its type: the clip, the
     * package then a null tag, and 0 for the user and the default device.
     */
    private static boolean setClip(ClipData clip) throws Exception {
        IBinder binder = (IBinder) Class.forName("android.os.ServiceManager")
            .getMethod("getService", String.class).invoke(null, "clipboard");
        if (binder == null) return false;
        Object service = Class.forName("android.content.IClipboard$Stub")
            .getMethod("asInterface", IBinder.class).invoke(null, binder);
        for (Method m : service.getClass().getMethods()) {
            if (!m.getName().equals("setPrimaryClip")) continue;
            Class<?>[] types = m.getParameterTypes();
            Object[] args = new Object[types.length];
            boolean packageSet = false;
            for (int i = 0; i < types.length; i++) {
                if (types[i] == ClipData.class) {
                    args[i] = clip;
                } else if (types[i] == String.class) {
                    args[i] = packageSet ? null : "com.android.shell";
                    packageSet = true;
                } else if (types[i] == int.class) {
                    args[i] = 0;
                } else {
                    args = null;
                    break;
                }
            }
            if (args == null) continue;
            m.invoke(service, args);
            return true;
        }
        return false;
    }

    /** The screen's size, so the pointer stays on it; 1920 by 1080 when the TV won't say. */
    private static void size() {
        try {
            Class<?> global = Class.forName("android.hardware.display.DisplayManagerGlobal");
            Object display = global.getMethod("getRealDisplay", int.class).invoke(global.getMethod("getInstance").invoke(null), 0);
            Point p = new Point();
            ((android.view.Display) display).getRealSize(p);
            if (p.x > 0 && p.y > 0) { screenW = p.x; screenH = p.y; }
        } catch (Throwable t) {
            // Keeps the default.
        }
        mouseX = screenW / 2f;
        mouseY = screenH / 2f;
    }

    /** One mouse command: see the class comment. False when the TV took none of it. */
    private static boolean mouse(Object manager, Method inject, String cmd) throws Exception {
        // An earlier build turned Pointer location on; this one never does, so it puts it away once.
        if (!sized) { sized = true; size(); overlay(false, false); }
        if (cmd.isEmpty()) return false;
        if (cmd.charAt(0) == 'o') {
            if (overlayOn) overlay(false, false);
            cursor("h");
            return true;
        }
        String arg = cmd.substring(1);
        boolean ok = mouseCommand(manager, inject, cmd.charAt(0), arg);
        cursor(Math.round(mouseX) + " " + Math.round(mouseY));
        return ok;
    }

    private static boolean mouseCommand(Object manager, Method inject, char op, String arg) throws Exception {
        switch (op) {
            case 'm': {
                String[] d = arg.split(",");
                mouseX = Math.max(0, Math.min(screenW - 1, mouseX + Integer.parseInt(d[0].trim())));
                mouseY = Math.max(0, Math.min(screenH - 1, mouseY + Integer.parseInt(d[1].trim())));
                return pointer(manager, inject, MotionEvent.ACTION_HOVER_MOVE, 0, 0f, 0, ASYNC);
            }
            case 'c': {
                long down = SystemClock.uptimeMillis();
                return pointer(manager, inject, MotionEvent.ACTION_DOWN, MotionEvent.BUTTON_PRIMARY, 0f, down, WAIT_FOR_FINISH)
                    && pointer(manager, inject, MotionEvent.ACTION_UP, 0, 0f, down, WAIT_FOR_FINISH);
            }
            case 's':
                return pointer(manager, inject, MotionEvent.ACTION_SCROLL, 0, Integer.parseInt(arg.trim()), 0, WAIT_FOR_FINISH);
            default:
                return false;
        }
    }

    /** Injects one mouse event at the pointer's place; [downTime] 0 is now. */
    private static boolean pointer(Object manager, Method inject, int action, int buttons, float wheel, long downTime, int mode) throws Exception {
        MotionEvent.PointerProperties props = new MotionEvent.PointerProperties();
        props.id = 0;
        props.toolType = MotionEvent.TOOL_TYPE_MOUSE;
        MotionEvent.PointerCoords coords = new MotionEvent.PointerCoords();
        coords.x = mouseX;
        coords.y = mouseY;
        coords.pressure = buttons != 0 ? 1f : 0f;
        coords.size = 1f;
        if (wheel != 0f) coords.setAxisValue(MotionEvent.AXIS_VSCROLL, wheel);
        long now = SystemClock.uptimeMillis();
        MotionEvent e = MotionEvent.obtain(downTime != 0 ? downTime : now, now, action, 1,
            new MotionEvent.PointerProperties[] { props }, new MotionEvent.PointerCoords[] { coords },
            0, buttons, 1f, 1f, 0, 0, InputDevice.SOURCE_MOUSE, 0);
        try {
            return (Boolean) inject.invoke(manager, e, mode);
        } finally {
            e.recycle();
        }
    }

    private static boolean send(Object manager, Method inject, long downTime, int action, int code, int meta) throws Exception {
        KeyEvent e = new KeyEvent(downTime, SystemClock.uptimeMillis(), action, code, 0, meta,
            KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD);
        return (Boolean) inject.invoke(manager, e, WAIT_FOR_FINISH);
    }
}
