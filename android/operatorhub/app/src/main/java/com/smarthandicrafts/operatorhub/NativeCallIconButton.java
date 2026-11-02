package com.smarthandicrafts.operatorhub;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.widget.Button;

/** Compact native vector controls. Labels and accessibility names remain real
 * text; no emoji, screenshot assets, video/keypad placeholders or text blocks. */
public final class NativeCallIconButton extends Button {
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private String icon;
    private boolean active;
    public NativeCallIconButton(Context context, String icon, String label, OnClickListener listener) {
        super(context); this.icon = icon; setText(label); setContentDescription(label);
        setBackgroundColor(Color.TRANSPARENT); setAllCaps(false); setPadding(0, 0, 0, 0);
        setMinimumWidth(0); setMinWidth(0); setMinimumHeight(NativeUi.dp(context, 92));
        setOnClickListener(listener); setFocusable(true);
    }
    public void icon(String value) { icon = value; invalidate(); }
    public void active(boolean value) { active = value; setSelected(value); invalidate(); }
    @Override public void setText(CharSequence value, android.widget.TextView.BufferType type) {
        super.setText(value, type); setContentDescription(value);
    }
    @Override protected void onDraw(Canvas canvas) {
        float density = getResources().getDisplayMetrics().density;
        float x = getWidth() / 2f, y = 36 * density, radius = 31 * density;
        boolean red = icon.equals("end") || icon.equals("decline");
        paint.setStyle(Paint.Style.FILL); paint.setColor(red ? Color.rgb(222, 26, 38)
            : icon.equals("accept") ? Color.rgb(0, 151, 116)
            : active ? Color.WHITE : Color.argb(isPressed() || isFocused() ? 105 : 45, 255, 255, 255));
        paint.setAlpha(isEnabled() ? 255 : 90); canvas.drawCircle(x, y, radius, paint);
        paint.setColor(active && !red ? Color.rgb(33, 52, 68) : Color.WHITE);
        paint.setAlpha(isEnabled() ? 255 : 100); paint.setStrokeWidth(2.2f);
        paint.setStrokeCap(Paint.Cap.ROUND); paint.setStrokeJoin(Paint.Join.ROUND); paint.setStyle(Paint.Style.STROKE);
        canvas.save(); canvas.translate(x, y); canvas.scale(density, density);
        switch (icon) {
            case "speaker":
                path(canvas, -13,-5, -8,-5, -2,-11, -2,11, -8,5, -13,5, -13,-5);
                canvas.drawArc(0,-8,12,8,-65,130,false,paint); canvas.drawArc(0,-13,21,13,-65,130,false,paint); break;
            case "mute":
                canvas.drawRoundRect(-4,-13,4,3,4,4,paint); canvas.drawArc(-9,-7,9,9,0,180,false,paint);
                canvas.drawLine(0,9,0,14,paint); canvas.drawLine(-5,14,5,14,paint);
                if (active) canvas.drawLine(-13,-14,13,14,paint); break;
            case "record":
                paint.setStyle(Paint.Style.FILL); paint.setColor(Color.rgb(255, 90, 95)); canvas.drawCircle(0,0,10,paint); break;
            case "stop":
                paint.setStyle(Paint.Style.FILL); paint.setColor(Color.rgb(255, 90, 95)); canvas.drawRoundRect(-8,-8,8,8,2,2,paint); break;
            case "notes":
                canvas.drawRoundRect(-10,-13,10,13,2,2,paint);
                canvas.drawLine(-5,-6,5,-6,paint); canvas.drawLine(-5,0,5,0,paint); canvas.drawLine(-5,6,2,6,paint); break;
            case "transfer":
                path(canvas,-13,8, -13,-3, 12,-3); path(canvas,5,-10,12,-3,5,4); break;
            case "complete": path(canvas,-12,0,-3,9,13,-9); break;
            case "merge":
                path(canvas,-12,12,-12,7,0,-5,0,-13); path(canvas,12,12,12,7,0,-5);
                path(canvas,-6,-7,0,-13,6,-7); break;
            case "cancel": path(canvas,-9,-9,9,9); path(canvas,-9,9,9,-9); break;
            case "accept":
                canvas.rotate(-45); handset(canvas); break;
            case "end": case "decline": handset(canvas); break;
        }
        canvas.restore();
        paint.setStyle(Paint.Style.FILL); paint.setColor(Color.WHITE); paint.setAlpha(isEnabled() ? 245 : 110);
        paint.setTextAlign(Paint.Align.CENTER); paint.setTypeface(android.graphics.Typeface.DEFAULT);
        paint.setTextSize(12 * getResources().getDisplayMetrics().scaledDensity);
        android.text.TextPaint labelPaint = new android.text.TextPaint(paint);
        String label = android.text.TextUtils.ellipsize(getText(), labelPaint, Math.max(1, getWidth() - 8 * density), android.text.TextUtils.TruncateAt.END).toString();
        canvas.drawText(label, x, 85 * density, paint);
    }
    private void handset(Canvas canvas) {
        Path p = new Path(); p.moveTo(-14,3); p.cubicTo(-14,-11,14,-11,14,3);
        p.lineTo(7,4); p.lineTo(7,-1); p.cubicTo(3,-4,-3,-4,-7,-1); p.lineTo(-7,4); p.close();
        paint.setStyle(Paint.Style.FILL); canvas.drawPath(p, paint);
    }
    private void path(Canvas canvas, float... points) {
        Path p = new Path(); p.moveTo(points[0],points[1]);
        for (int i = 2; i < points.length; i += 2) p.lineTo(points[i],points[i+1]); canvas.drawPath(p,paint);
    }
}
