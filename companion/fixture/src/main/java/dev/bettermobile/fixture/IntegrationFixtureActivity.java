package dev.polyscreen.fixture;

import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

public final class IntegrationFixtureActivity extends Activity {
    private TextView status;
    private int tapCount;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(24), dp(12), dp(24), dp(12));
        root.setBackgroundColor(Color.rgb(24, 27, 33));

        TextView title = text("PolyScreen MCP integration fixture", 24);
        root.addView(title, matchWrap());

        status = text("ready", 18);
        status.setId(R.id.integration_status);
        status.setContentDescription("Integration status");
        root.addView(status, matchWrap());

        Button tapTarget = new Button(this);
        tapTarget.setId(R.id.integration_tap_target);
        tapTarget.setText("Tap target");
        tapTarget.setContentDescription("Tap target");
        tapTarget.setOnClickListener(
                ignored -> {
                    tapCount += 1;
                    setStatus("tap:" + tapCount);
                });
        root.addView(tapTarget, matchWrap());

        GestureView gestureTarget = new GestureView();
        gestureTarget.setId(R.id.integration_gesture_target);
        gestureTarget.setContentDescription("Gesture target");
        gestureTarget.setBackgroundColor(Color.rgb(49, 62, 78));
        LinearLayout.LayoutParams gestureParams =
                new LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        dp(140));
        gestureParams.setMargins(0, dp(8), 0, dp(8));
        root.addView(gestureTarget, gestureParams);

        EditText input = new EditText(this);
        input.setId(R.id.integration_text_input);
        input.setHint("Type integration text");
        input.setSingleLine(true);
        input.setTextColor(Color.WHITE);
        input.setHintTextColor(Color.LTGRAY);
        input.setContentDescription("Integration text input");
        root.addView(input, matchWrap());

        setContentView(root);
    }

    private TextView text(String value, int sizeSp) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextColor(Color.WHITE);
        view.setTextSize(sizeSp);
        view.setGravity(Gravity.CENTER_VERTICAL);
        view.setPadding(0, dp(8), 0, dp(8));
        return view;
    }

    private LinearLayout.LayoutParams matchWrap() {
        return new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void setStatus(String value) {
        status.setText(value);
    }

    private final class GestureView extends View {
        private float startX;
        private float startY;

        GestureView() {
            super(IntegrationFixtureActivity.this);
        }

        @Override
        public boolean onTouchEvent(MotionEvent event) {
            if (event.getActionMasked() == MotionEvent.ACTION_DOWN) {
                startX = event.getX();
                startY = event.getY();
                setStatus("gesture:down");
                return true;
            }
            if (event.getActionMasked() == MotionEvent.ACTION_UP) {
                float deltaX = event.getX() - startX;
                float deltaY = event.getY() - startY;
                if (Math.abs(deltaX) < dp(24) && Math.abs(deltaY) < dp(24)) {
                    setStatus("gesture:tap");
                } else if (Math.abs(deltaX) >= Math.abs(deltaY)) {
                    setStatus(deltaX >= 0 ? "gesture:right" : "gesture:left");
                } else {
                    setStatus(deltaY >= 0 ? "gesture:down" : "gesture:up");
                }
                performClick();
                return true;
            }
            return true;
        }

        @Override
        public boolean performClick() {
            super.performClick();
            return true;
        }
    }
}
