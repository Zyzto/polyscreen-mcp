package dev.bettermobile.companion;

import android.app.Activity;
import android.app.Instrumentation;
import android.app.UiAutomation;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.SparseArray;
import android.view.InputDevice;
import android.view.KeyCharacterMap;
import android.view.KeyEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import android.net.LocalServerSocket;
import android.net.LocalSocket;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.EOFException;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

public final class BridgeInstrumentation extends Instrumentation {
    private static final int MAX_FRAME_BYTES = 1024 * 1024;

    private final Map<Integer, HeldKey> heldKeys = new HashMap<>();
    private volatile boolean running = true;
    private UiAutomation automation;
    private String socketName;
    private String token;

    @Override
    public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        token = arguments.getString("token", "");
        socketName = arguments.getString("socket", "");
        if (token.length() < 16) {
            throw new IllegalArgumentException("A random token of at least 16 characters is required");
        }
        if (!socketName.matches("better_mobile_mcp_[A-Za-z0-9_-]{16,}")) {
            throw new IllegalArgumentException("A random companion socket name is required");
        }
        start();
    }

    @Override
    public void onStart() {
        automation = getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
        AccessibilityServiceInfo serviceInfo = automation.getServiceInfo();
        serviceInfo.flags |= AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
        automation.setServiceInfo(serviceInfo);
        try (LocalServerSocket server = new LocalServerSocket(socketName)) {
            while (running) {
                try (LocalSocket client = server.accept()) {
                    try {
                        serve(client);
                    } catch (Exception malformedClient) {
                        // Reject only this client; keep the instrumentation available for the owner.
                    }
                } finally {
                    releaseAll();
                }
            }
            finish(Activity.RESULT_OK, new Bundle());
        } catch (Exception error) {
            Bundle result = new Bundle();
            result.putString("error", error.toString());
            finish(Activity.RESULT_CANCELED, result);
        } finally {
            releaseAll();
        }
    }

    private void serve(LocalSocket client) throws Exception {
        DataInputStream input =
                new DataInputStream(new BufferedInputStream(client.getInputStream()));
        DataOutputStream output =
                new DataOutputStream(new BufferedOutputStream(client.getOutputStream()));
        boolean authenticated = false;

        while (running) {
            final int length;
            try {
                length = input.readInt();
            } catch (EOFException closed) {
                return;
            }
            if (length <= 0 || length > MAX_FRAME_BYTES) {
                throw new IllegalArgumentException("Invalid frame length: " + length);
            }
            byte[] payload = new byte[length];
            input.readFully(payload);
            JSONObject request = new JSONObject(new String(payload, StandardCharsets.UTF_8));
            JSONObject response;

            if (!authenticated) {
                authenticated =
                        "hello".equals(request.optString("op"))
                                && token.equals(request.optString("token"));
                response =
                        authenticated
                                ? hello(request.optLong("id"))
                                : error(request.optLong("id"), "AUTHENTICATION_FAILED");
            } else {
                response = handle(request);
            }
            writeFrame(output, response);
            if (!authenticated) return;
        }
    }

    private JSONObject handle(JSONObject request) {
        long id = request.optLong("id");
        try {
            switch (request.getString("op")) {
                case "key":
                    return key(id, request);
                case "releaseAll":
                    releaseAll();
                    return ok(id);
                case "windows":
                    return windows(id);
                case "shutdown":
                    running = false;
                    releaseAll();
                    return ok(id);
                default:
                    return error(id, "UNSUPPORTED_OPERATION");
            }
        } catch (Exception error) {
            return error(id, error.toString());
        }
    }

    private JSONObject key(long id, JSONObject request) throws Exception {
        int keyCode = request.getInt("keyCode");
        String action = request.optString("action", "press");
        int source = parseSource(request.optString("source", "gamepad"));
        int metaState = request.optInt("metaState", 0);
        int repeat = request.optInt("repeat", 0);
        long now = SystemClock.uptimeMillis();

        if ("down".equals(action)) {
            HeldKey held = heldKeys.get(keyCode);
            long downTime = held == null ? now : held.downTime;
            boolean injected =
                    inject(
                            new KeyEvent(
                                    downTime,
                                    now,
                                    KeyEvent.ACTION_DOWN,
                                    keyCode,
                                    repeat,
                                    metaState,
                                    KeyCharacterMap.VIRTUAL_KEYBOARD,
                                    0,
                                    repeat > 0 ? KeyEvent.FLAG_LONG_PRESS : 0,
                                    source));
            if (injected) {
                heldKeys.put(keyCode, new HeldKey(downTime, source, metaState));
            }
            return result(id, injected);
        }

        if ("up".equals(action)) {
            HeldKey held = heldKeys.get(keyCode);
            long downTime = held == null ? now : held.downTime;
            int eventSource = held == null ? source : held.source;
            int eventMeta = held == null ? metaState : held.metaState;
            boolean injected =
                    inject(
                            new KeyEvent(
                                    downTime,
                                    now,
                                    KeyEvent.ACTION_UP,
                                    keyCode,
                                    0,
                                    eventMeta,
                                    KeyCharacterMap.VIRTUAL_KEYBOARD,
                                    0,
                                    0,
                                    eventSource));
            if (injected) heldKeys.remove(keyCode);
            return result(id, injected);
        }

        if ("press".equals(action)) {
            JSONObject down = new JSONObject(request.toString()).put("action", "down");
            JSONObject downResult = key(id, down);
            if (!downResult.optBoolean("ok")) return downResult;
            JSONObject up = new JSONObject(request.toString()).put("action", "up");
            return key(id, up);
        }

        throw new IllegalArgumentException("Unknown key action: " + action);
    }

    private boolean inject(KeyEvent event) {
        return automation.injectInputEvent(event, false);
    }

    private void releaseAll() {
        for (int attempt = 0; attempt < 3 && !heldKeys.isEmpty(); attempt++) {
            long now = SystemClock.uptimeMillis();
            Iterator<Map.Entry<Integer, HeldKey>> iterator = heldKeys.entrySet().iterator();
            while (iterator.hasNext()) {
                Map.Entry<Integer, HeldKey> entry = iterator.next();
                HeldKey held = entry.getValue();
                boolean injected =
                        inject(
                                new KeyEvent(
                                        held.downTime,
                                        now,
                                        KeyEvent.ACTION_UP,
                                        entry.getKey(),
                                        0,
                                        held.metaState,
                                        KeyCharacterMap.VIRTUAL_KEYBOARD,
                                        0,
                                        0,
                                        held.source));
                if (injected) iterator.remove();
            }
        }
    }

    private JSONObject windows(long id) {
        JSONArray displays = new JSONArray();
        SparseArray<List<AccessibilityWindowInfo>> all = automation.getWindowsOnAllDisplays();
        for (int index = 0; index < all.size(); index++) {
            int displayId = all.keyAt(index);
            JSONArray windows = new JSONArray();
            for (AccessibilityWindowInfo window : all.valueAt(index)) {
                AccessibilityNodeInfo root = window.getRoot();
                try {
                    JSONObject item = new JSONObject();
                    put(item, "id", window.getId());
                    put(item, "type", window.getType());
                    put(item, "layer", window.getLayer());
                    put(item, "active", window.isActive());
                    put(item, "focused", window.isFocused());
                    put(item, "title", String.valueOf(window.getTitle()));
                    if (root != null) {
                        put(item, "packageName", String.valueOf(root.getPackageName()));
                    }
                    windows.put(item);
                } finally {
                    if (root != null) root.recycle();
                    window.recycle();
                }
            }
            displays.put(object("displayId", displayId, "windows", windows));
        }
        return put(ok(id), "displays", displays);
    }

    private JSONObject hello(long id) {
        JSONObject capabilities =
                object(
                        "keyDownUp", true,
                        "keyRepeats", true,
                        "keyDisplayTarget", false,
                        "windowsOnAllDisplays", true,
                        "joystickAxes", false,
                        "physicalDeviceIdentity", false);
        return object(
                "id", id,
                "ok", true,
                "protocol", 1,
                "backend", "uiautomation",
                "capabilities", capabilities);
    }

    private static int parseSource(String source) {
        switch (source) {
            case "keyboard":
                return InputDevice.SOURCE_KEYBOARD;
            case "dpad":
                return InputDevice.SOURCE_DPAD;
            case "gamepad":
                return InputDevice.SOURCE_GAMEPAD;
            case "joystick":
                return InputDevice.SOURCE_JOYSTICK;
            default:
                throw new IllegalArgumentException("Unknown input source: " + source);
        }
    }

    private static JSONObject ok(long id) {
        return object("id", id, "ok", true);
    }

    private static JSONObject result(long id, boolean injected) {
        return object("id", id, "ok", injected, "injected", injected);
    }

    private static JSONObject error(long id, String message) {
        return object("id", id, "ok", false, "error", message);
    }

    private static JSONObject object(Object... pairs) {
        JSONObject result = new JSONObject();
        for (int index = 0; index < pairs.length; index += 2) {
            put(result, String.valueOf(pairs[index]), pairs[index + 1]);
        }
        return result;
    }

    private static JSONObject put(JSONObject object, String key, Object value) {
        try {
            object.put(key, value);
            return object;
        } catch (Exception error) {
            throw new IllegalStateException("Could not encode companion response", error);
        }
    }

    private static void writeFrame(DataOutputStream output, JSONObject response) throws Exception {
        byte[] bytes = response.toString().getBytes(StandardCharsets.UTF_8);
        output.writeInt(bytes.length);
        output.write(bytes);
        output.flush();
    }

    private static final class HeldKey {
        final long downTime;
        final int source;
        final int metaState;

        HeldKey(long downTime, int source, int metaState) {
            this.downTime = downTime;
            this.source = source;
            this.metaState = metaState;
        }
    }
}
