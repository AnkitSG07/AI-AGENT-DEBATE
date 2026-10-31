package com.smarthandicrafts.operatorhub;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;

/** Composes the unchanged company PNG on a white notification canvas, preserving aspect ratio. */
public final class NativeBrand {
    public static final int GREEN = Color.rgb(0, 135, 107);
    public static final int RED = Color.rgb(199, 55, 67);
    private static Bitmap logo;
    public static synchronized Bitmap logo(Context context) {
        if (logo != null) return logo;
        BitmapFactory.Options options = new BitmapFactory.Options(); options.inSampleSize = 4;
        Bitmap source = BitmapFactory.decodeResource(context.getResources(), R.drawable.company_logo, options);
        logo = Bitmap.createBitmap(192, 192, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(logo); canvas.drawColor(Color.WHITE);
        if (source != null) {
            float scale = Math.min(192f / source.getWidth(), 192f / source.getHeight());
            float width = source.getWidth() * scale, height = source.getHeight() * scale;
            canvas.drawBitmap(source, null, new RectF((192 - width) / 2, (192 - height) / 2, (192 + width) / 2, (192 + height) / 2), new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG));
            source.recycle();
        }
        return logo;
    }
    private NativeBrand() { }
}
