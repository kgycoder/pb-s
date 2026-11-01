package com.sync.app.glass

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.GraphicsLayerScope
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.layout
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.util.lerp
import com.kyant.backdrop.Backdrop
import com.kyant.backdrop.drawBackdrop
import com.kyant.backdrop.effects.blur
import com.kyant.backdrop.effects.lens
import com.kyant.backdrop.effects.vibrancy
import com.kyant.shapes.Capsule
import com.sync.app.glass.kyant.InteractiveHighlight
import kotlin.math.roundToInt

/** 합쳐질 때 높이가 접히며 사라지는 보조 텍스트(채널명)용. */
private fun Modifier.fadeCollapse(compact: () -> Float): Modifier = layout { measurable, constraints ->
    val f = (1f - compact()).coerceIn(0f, 1f)
    val p = measurable.measure(constraints)
    layout(p.width, (p.height * f).roundToInt()) {
        p.placeRelativeWithLayer(0, 0) { alpha = f }
    }
}

/** 합쳐질 때 크기가 부드럽게 줄어드는 고정 크기 요소(앨범아트·다음곡 버튼)용. */
private fun Modifier.lerpSize(compact: () -> Float, fromW: Dp, toW: Dp, fromH: Dp, toH: Dp): Modifier =
    layout { measurable, _ ->
        val f = compact().coerceIn(0f, 1f)
        val w = lerp(fromW.toPx(), toW.toPx(), f).roundToInt()
        val h = lerp(fromH.toPx(), toH.toPx(), f).roundToInt()
        val p = measurable.measure(Constraints.fixed(w, h))
        layout(w, h) { p.place(0, 0) }
    }

/**
 * 미니 플레이어 한 줄: artwork · title/channel · play · next.
 * [compact] 0 → 1 이 되면(하단 도크로 합쳐질 때) 채널명이 접히고 아트/다음곡 버튼이 작아진다.
 * 재생/일시정지와 다음곡 모두 배경 없는 흰색 단색 글리프.
 */
@Composable
private fun BarRow(bar: BarState, c: GlassController, compact: () -> Float) {
    val art = rememberRemoteImage(bar.art)
    Row(
        Modifier.fillMaxSize().padding(start = 9.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(
            Modifier
                .lerpSize(compact, 40.dp, 34.dp, 40.dp, 34.dp)
                .clip(RoundedCornerShape(9.dp))
                .background(Color.White.copy(0.08f))
                .tap { c.cmd { put("t", "bar"); put("a", "open") } }
        ) {
            if (art != null) Image(art, null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
        }
        Column(
            Modifier
                .weight(1f)
                .padding(horizontal = 9.dp)
                .tap { c.cmd { put("t", "bar"); put("a", "open") } },
            verticalArrangement = Arrangement.spacedBy(1.dp, Alignment.CenterVertically)
        ) {
            BasicText(
                bar.title, maxLines = 1, overflow = TextOverflow.Ellipsis,
                style = TextStyle(Color.White.copy(0.96f), 13.sp, FontWeight.SemiBold)
            )
            BasicText(
                bar.channel, maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.fadeCollapse(compact),
                style = TextStyle(Color.White.copy(0.55f), 10.5f.sp)
            )
        }
        // play / pause — 배경 없는 흰색 단색 글리프 (다음곡 버튼과 동일한 방식)
        Box(
            Modifier.size(38.dp).tap { c.cmd { put("t", "bar"); put("a", "play") } },
            contentAlignment = Alignment.Center
        ) {
            Canvas(Modifier.size(18.dp)) {
                fillIcon(if (bar.playing) GlassIcons.PauseFill else GlassIcons.PlayFill, 512f, Color.White)
            }
        }
        // NEXT (source path is a "previous" glyph → mirrored like the original CSS scaleX(-1))
        Box(
            Modifier
                .lerpSize(compact, 40.dp, 32.dp, 38.dp, 38.dp)
                .tap { c.cmd { put("t", "bar"); put("a", "next") } },
            contentAlignment = Alignment.Center
        ) {
            Canvas(Modifier.size(18.dp)) {
                scale(-1f, 1f, pivot = center) { fillIcon(GlassIcons.NextFill, 512f, Color.White) }
            }
        }
    }
}

/** 미니 플레이어의 유리 캡슐 + 내용. 위치/크기는 호출하는 쪽이 [modifier] 로 정한다. */
@Composable
internal fun BarSurface(
    bar: BarState,
    backdrop: Backdrop,
    c: GlassController,
    modifier: Modifier,
    compact: () -> Float = { 0f },
    layerBlock: (GraphicsLayerScope.() -> Unit)? = null
) {
    val scope = rememberCoroutineScope()
    val highlight = remember(scope) { InteractiveHighlight(scope) }
    Box(
        modifier
            .drawBackdrop(
                backdrop = backdrop,
                shape = { Capsule() },
                effects = {
                    vibrancy()
                    blur(2f.dp.toPx())
                    lens(24f.dp.toPx(), 24f.dp.toPx())
                },
                layerBlock = layerBlock,
                onDrawSurface = { drawRect(GlassTheme.Container) }
            )
            .then(highlight.modifier)
            .then(highlight.gestureModifier)
    ) {
        BarRow(bar, c, compact)
    }
}

/** 도크가 없을 때(가로 모드 등)의 단독 미니 플레이어: DOM 이 알려준 위치에 그대로 그린다. */
@Composable
internal fun BarGlass(bar: BarState, backdrop: Backdrop, c: GlassController) {
    BarSurface(bar, backdrop, c, Modifier.cssRect(bar.rect))
}
