package com.smarthandicrafts.operatorhub;

import android.content.Context;
import android.content.res.Configuration;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

public final class NativeUi {
    public static boolean dark(Context c) { return (c.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES; }
    public static int background(Context c) { return Color.parseColor(dark(c) ? "#111B21" : "#FFFFFF"); }
    public static int foreground(Context c) { return Color.parseColor(dark(c) ? "#E9EDEF" : "#15242B"); }
    public static int muted(Context c) { return Color.parseColor(dark(c) ? "#A7B5BD" : "#60747F"); }
    public static int dp(Context c, int value) { return Math.round(value * c.getResources().getDisplayMetrics().density); }
    public static TextView text(Context c, String value, int size, boolean bold) {
        TextView v = new TextView(c); v.setText(value); v.setTextSize(size); v.setTextColor(foreground(c));
        if (bold) v.setTypeface(Typeface.DEFAULT, Typeface.BOLD); v.setPadding(0, dp(c, 8), 0, dp(c, 8)); return v;
    }
    public static Button button(Context c, String label, View.OnClickListener click) {
        Button b = new Button(c); b.setText(label); b.setAllCaps(false); b.setTextColor(Color.WHITE); b.setTextSize(16);
        GradientDrawable shape = new GradientDrawable(); shape.setColor(Color.parseColor("#00876B")); shape.setCornerRadius(dp(c, 18)); b.setBackground(new RippleDrawable(ColorStateList.valueOf(Color.argb(55,255,255,255)),shape,null));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, dp(c, 52)); lp.setMargins(0, dp(c, 8), 0, dp(c, 8)); b.setLayoutParams(lp); b.setOnClickListener(click); return b;
    }
    private NativeUi() { }
}
