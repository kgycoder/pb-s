package com.sync.app.glass

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.AnimationVector1D
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.util.lerp
import com.kyant.backdrop.Backdrop
import com.sync.app.glass.kyant.LiquidBottomTab
import com.sync.app.glass.kyant.LiquidBottomTabs
import com.sync.app.glass.kyant.LiquidButton
import kotlin.math.PI
import kotlin.math.roundToInt
import kotlin.math.sin

/**
 * Apple Music 스타일 하단 도크.
 *
 *  평상시      : [ 홈 · 즐겨찾기 · 대기열 · 플레이리스트 (탭 캡슐) ]  [ 🔍 (단일 캡슐) ]
 *               미니 플레이어는 그 위에 별도 캡슐로 떠 있다.
 *  합쳐진 상태 : [ 🏠 ]  [ 미니 플레이어(축소) ]  [ 🔍 ]   ← 재생 중 아래로 스크롤할 때
 *               위로 스크롤하면 스프링(블룹)으로 평상시 배치로 돌아간다.
 *
 * 모든 위치/크기는 [merge] 값(0..1, 스프링이라 살짝 넘칠 수 있음)에서 레이아웃·그리기 단계에서만 계산한다
 * → 애니메이션 중 recomposition 이 일어나지 않고, 각 요소는 같은 식으로 배치되어 서로 겹치거나 밀리지 않는다.
 */

/** 도크 탭 = DOM 순서(홈, 검색, 즐겨찾기, 대기열, 플레이리스트) 중 '검색'을 뺀 4개. */
private val TabLabels = listOf("홈", "즐겨찾기", "대기열", "플레이리스트")
private val TabDom = intArrayOf(0, 2, 3, 4)
private val TabViews = listOf("home", "fav", "queue", "playlists")
private const val DOM_SEARCH = 1
private const val GAP = 14f          // 탭 캡슐 ↔ 검색 캡슐 (CSS px == dp)
private const val MERGED_GAP = 8f    // 합쳐졌을 때 가운데 플레이어 ↔ 좌우 캡슐

private class Px(val x: Float, val y: Float, val w: Float, val h: Float)

/** [rect] 를 레이아웃 단계에서 읽어 위치와 크기를 정한다(상태 읽기 = 레이아웃 무효화만, recomposition 없음). */
private fun Modifier.place(rect: () -> Px): Modifier = this
    .offset { val p = rect(); IntOffset(p.x.roundToInt(), p.y.roundToInt()) }
    .layout { measurable, _ ->
        val p = rect()
        val w = p.w.roundToInt().coerceAtLeast(0)
        val h = p.h.roundToInt().coerceAtLeast(0)
        val pl = measurable.measure(Constraints.fixed(w, h))
        layout(w, h) { pl.place(0, 0) }
    }

@Composable
internal fun DockGlass(
    nav: NavState,
    bar: BarState?,
    backdrop: Backdrop,
    c: GlassController,
    merge: Animatable<Float, AnimationVector1D>
) {
    val d = LocalDensity.current.density
    val r = nav.rect
    val h = r.h
    val accent = LocalGlassAccent.current

    // ── 선택 상태 ───────────────────────────────────────────────
    // 항상 DOM 이 마지막으로 알려준 탭 (일시적으로 nav 가 사라져도 0 으로 튀지 않는다).
    val active = rememberUpdatedState(nav.active)
    val tabIdx = TabDom.indexOf(nav.active)              // 검색 화면이면 -1
    val lastTab = remember { mutableIntStateOf(maxOf(tabIdx, 0)) }
    LaunchedEffect(tabIdx) { if (tabIdx >= 0) lastTab.intValue = tabIdx }
    val selected = remember { { lastTab.intValue } }
    val onSelected = remember(c) {
        { index: Int ->
            if (TabDom[index] != active.value) c.cmd { put("t", "nav"); put("v", TabViews[index]) }
        }
    }
    val searchActive = nav.active == DOM_SEARCH
    val indicatorShown by animateFloatAsState(if (searchActive) 0f else 1f, label = "tabIndicator")
    val homeTappable by remember { derivedStateOf { merge.value > 0.5f } }

    // ── 위치 계산(px) ───────────────────────────────────────────
    val tabsRect = remember(r, d) {
        val f: () -> Px = { Px(r.x * d, r.y * d, lerp((r.w - h - GAP) * d, h * d, merge.value.coerceIn(0f, 1f)), h * d) }
        f
    }
    val searchRect = remember(r, d) {
        val f: () -> Px = { Px((r.x + r.w - h) * d, r.y * d, h * d, h * d) }
        f
    }
    val barCss = bar?.rect
    val barRect = remember(barCss, r, d) {
        val f: () -> Px = {
            if (barCss == null) Px(0f, 0f, 0f, 0f) else {
                val m = merge.value                                   // 스프링 오버슈트 허용(= 블룹)
                val mw = r.w - 2f * (h + MERGED_GAP)
                Px(
                    lerp(barCss.x, r.x + h + MERGED_GAP, m) * d, lerp(barCss.y, r.y, m) * d,
                    lerp(barCss.w, mw, m) * d, lerp(barCss.h, h, m) * d
                )
            }
        }
        f
    }

    Box(Modifier.fillMaxSize()) {
        // ① 탭 캡슐 (합쳐지면 홈 단일 캡슐로 줄어든다)
        Box(Modifier.place(tabsRect)) {
            LiquidBottomTabs(
                selectedTabIndex = selected,
                onTabSelected = onSelected,
                backdrop = backdrop,
                tabsCount = TabLabels.size,
                accentColor = accent,
                modifier = Modifier.fillMaxSize(),
                height = h.dp,
                indicatorInteractive = !searchActive,
                indicatorAlpha = { indicatorShown * (1f - merge.value * 2.2f).coerceIn(0f, 1f) }
            ) {
                repeat(TabLabels.size) { index ->
                    LiquidBottomTab({ onSelected(index) }) {
                        Canvas(
                            Modifier.size(22.dp).graphicsLayer { alpha = (1f - merge.value * 2.2f).coerceIn(0f, 1f) }
                        ) {
                            strokeIcon(GlassIcons.Nav[TabDom[index]], 20f, GlassTheme.Content.copy(0.8f), 1.6f)
                        }
                        BasicText(
                            TabLabels[index],
                            modifier = Modifier.graphicsLayer { alpha = (1f - merge.value * 2.2f).coerceIn(0f, 1f) },
                            style = TextStyle(GlassTheme.Content.copy(0.8f), 10.sp, FontWeight.Medium),
                            maxLines = 1, softWrap = false, overflow = TextOverflow.Clip
                        )
                    }
                }
            }
            // 합쳐진 상태의 '홈' 글리프 + 탭 (합쳐졌을 때만 구성 → 평상시 탭 터치에 영향 없음)
            if (homeTappable) {
                Box(
                    Modifier
                        .fillMaxSize()
                        .graphicsLayer { alpha = ((merge.value - 0.35f) * 2.5f).coerceIn(0f, 1f) }
                        .tap {
                            c.expand(); c.cmd { put("t", "nav"); put("v", "home") }
                        },
                    contentAlignment = Alignment.Center
                ) {
                    Canvas(Modifier.size(24.dp)) {
                        strokeIcon(
                            GlassIcons.Home, 20f,
                            if (nav.active == 0) accent else GlassTheme.Content.copy(0.85f), 1.6f
                        )
                    }
                }
            }
        }

        // ② 검색 캡슐 (오른쪽 단일 캡슐 — 크기·위치는 합쳐져도 그대로)
        Box(Modifier.place(searchRect)) {
            LiquidButton(
                onClick = { c.expand(); c.cmd { put("t", "nav"); put("v", "search") } },
                backdrop = backdrop,
                modifier = Modifier.fillMaxSize(),
                surfaceColor = if (searchActive) Color.White.copy(0.14f).compositeOver(GlassTheme.Container)
                else GlassTheme.Container
            ) {
                Canvas(Modifier.size(21.dp)) {
                    strokeIcon(GlassIcons.Search, 20f, if (searchActive) accent else GlassTheme.Content.copy(0.85f), 1.7f)
                }
            }
        }

        // ③ 미니 플레이어 (평상시: 도크 위 / 합쳐지면: 도크 중앙으로 내려와 축소)
        if (bar != null) {
            BarSurface(
                bar, backdrop, c,
                modifier = Modifier.place(barRect),
                compact = { merge.value.coerceIn(0f, 1f) },
                layerBlock = {
                    // 블룹: 이동 중간에 살짝 눌렸다가(가로로 퍼짐) 제자리에서 복원
                    val bump = sin(PI.toFloat() * merge.value.coerceIn(0f, 1f))
                    scaleX = 1f + 0.035f * bump
                    scaleY = 1f - 0.07f * bump
                }
            )
        }
    }
}
