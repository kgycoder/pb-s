/* ════════════════════════════════════════════════════════════════════
   PLAYLIST EDIT MODE  (플레이리스트 곡 UI 상호작용)
   - 곡 행을 길게 누르면 edit 상태 → 행 옆에 Context Menu(곡 즐겨찾기 / 곡 삭제)가 나타난다.
     Context Menu 의 유리 표면은 네이티브(Kyant backdrop)가 그린다 → glass-bridge.js 가 DOM 상태를 미러링.
   - edit 상태의 행을 위/아래로 끌면 순서가 바뀐다. 행은 플레이리스트 목록(#pl-track-list) 밖으로 나가지 않고,
     나머지 행은 겹치지 않게 순차적으로 부드럽게 자리를 비켜 준다.
   - 성능: 드래그 중에는 레이아웃을 건드리지 않는다(transform 만 사용, rAF 로 프레임당 1회 갱신).
     측정(offsetTop/offsetHeight)은 드래그 시작 시 1번뿐이고, 끝나면 DOM 을 한 번만 옮긴다(전체 재렌더 없음).
   - app.js 의 재생/플레이리스트 로직은 그대로 사용한다 (PL, plById, plSave, plRemoveTrack, toggleFavTrack, S ...).
════════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    const LONG_MS = 420;          // 롱프레스 판정 시간
    const SLOP = 9;               // 롱프레스 대기 중 허용 이동(px) — 넘으면 스크롤로 판단
    const DRAG_START = 4;         // edit 상태에서 드래그로 인정하는 최소 이동(px)
    const MENU_W = 196, MENU_H = 108;   // style: #pl-edit-menu (패딩 8 + 행 46 × 2)
    const DOCK_SAFE = 156;        // 하단 도크(내비 + 미니 플레이어) 영역 — 메뉴/자동 스크롤이 피해야 할 높이
    const EASE = 'cubic-bezier(.22,1,.36,1)';

    const $ = id => document.getElementById(id);
    const list = $('pl-track-list');
    if (!list) return;

    const E = { active: false, row: null, id: null, plId: null };
    let press = null;             // 롱프레스/드래그 대기 상태
    let drag = null;              // 진행 중인 드래그
    let settling = false;         // 놓은 뒤 제자리로 안착하는 중
    let suppressUntil = 0;        // 롱프레스/드래그 직후 발생하는 click 무시
    let lastTouchAt = 0;          // 터치 후 에뮬레이션되는 mouse 이벤트 무시용
    let menuTimer = 0, scrollTimer = 0, hinted = false;

    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const suppress = ms => { suppressUntil = Math.max(suppressUntil, Date.now() + ms); };
    function buzz(ms) { try { if (navigator.vibrate) navigator.vibrate(ms || 12); } catch (e) { } }
    const rowsOf = () => Array.from(list.querySelectorAll('.pl-track'));
    const curTrack = () => {
        const pl = typeof plById === 'function' ? plById(E.plId) : null;
        return pl ? pl.tracks.find(t => t.id === E.id) || null : null;
    };

    /* ───────── Context Menu ───────── */
    function menuEl() { return $('pl-edit-menu'); }
    function hideMenu() {
        clearTimeout(menuTimer);
        const m = menuEl(); if (m) m.classList.remove('on');
    }
    function refreshMenuState() {
        const fav = $('pl-edm-fav'), t = curTrack();
        if (fav) fav.classList.toggle('on', !!(t && isFav(t.id)));
    }
    /** 행 옆(오른쪽 정렬, 아래 → 공간이 없으면 위)에 메뉴를 놓는다. 행이 화면 밖이면 숨긴다. */
    function placeMenu() {
        const m = menuEl(), row = E.row;
        if (!m || !row || !row.isConnected) return false;
        const r = row.getBoundingClientRect(), vw = innerWidth, vh = innerHeight;
        if (r.bottom < 56 || r.top > vh - 80) return false;
        const x = clamp(r.right - MENU_W - 10, 12, vw - MENU_W - 12);
        const limit = vh - DOCK_SAFE;
        let y = r.bottom + 8;
        if (y + MENU_H > limit) y = r.top - MENU_H - 8;
        y = clamp(y, 64, Math.max(64, limit - MENU_H));
        m.style.left = Math.round(x) + 'px';
        m.style.top = Math.round(y) + 'px';
        return true;
    }
    function showMenu(delay) {
        clearTimeout(menuTimer);
        menuTimer = setTimeout(() => {
            if (!E.active || drag || settling) return;
            refreshMenuState();
            const m = menuEl();
            if (m && placeMenu()) m.classList.add('on');
        }, delay || 0);
    }

    /* ───────── edit 상태 진입/해제 ───────── */
    function enter(row) {
        if (!row || !row.isConnected) return;
        if (E.active && E.row !== row) exit(true);
        E.active = true; E.row = row; E.id = row.dataset.id;
        E.plId = (typeof PL !== 'undefined') ? PL.curId : null;
        list.classList.add('pl-editing');
        row.classList.add('editing');
        buzz(14);
        if (!hinted && typeof toast === 'function') { hinted = true; toast('위아래로 끌어서 순서를 바꿀 수 있어요'); }
        showMenu(140);   // 행이 살짝 떠오른 뒤 메뉴가 나타난다
    }
    function exit() {
        if (drag) cancelDrag();
        hideMenu();
        clearTimeout(scrollTimer);
        list.classList.remove('pl-editing');
        list.querySelectorAll('.pl-track.editing').forEach(r => r.classList.remove('editing'));
        E.active = false; E.row = null; E.id = null;
        settling = false;
    }
    window.plEditActive = () => E.active;
    window.plEditExit = exit;

    /* ───────── 메뉴 동작 ───────── */
    window.plEditFav = function () {
        const t = curTrack(); if (!t) return;
        toggleFavTrack(t);            // app.js: 즐겨찾기 토글 + 저장 + 관련 화면 갱신
        refreshMenuState();
    };
    window.plEditDelete = function () {
        const row = E.row, id = E.id, plId = E.plId;
        if (!row || !id || !plId) return;
        hideMenu();
        settling = true;              // 삭제 연출 중에는 새 제스처를 받지 않는다
        row.classList.remove('editing');
        row.style.transition = 'height .24s ' + EASE + ', opacity .18s linear, padding .24s ' + EASE + ', border-width .24s linear';
        row.style.overflow = 'hidden';
        row.style.height = row.offsetHeight + 'px';
        void row.offsetHeight;        // 현재 높이를 확정한 뒤 접는다
        row.style.height = '0px'; row.style.paddingTop = '0px'; row.style.paddingBottom = '0px';
        row.style.borderWidth = '0px'; row.style.opacity = '0';
        setTimeout(() => {
            exit();                   // plRemoveTrack → plRenderDetail 이 목록을 다시 그린다
            plRemoveTrack(plId, id);
            if (typeof toast === 'function') toast('곡을 삭제했어요');
        }, 250);
    };

    /* ───────── 드래그 정렬 ───────── */
    function startDrag(p, cx, cy) {
        const row = p.row;
        const rows = rowsOf(), from = rows.indexOf(row);
        if (from < 0 || rows.length < 1) return;
        hideMenu();
        const tops = rows.map(r => r.offsetTop), hs = rows.map(r => r.offsetHeight);
        const last = rows.length - 1;
        drag = {
            row, rows, from, to: from, tops, hs,
            hmap: new Map(rows.map((r, i) => [r, hs[i]])),
            newTop: new Map(),
            startClientY: p.y, startScroll: p.sy,
            cx, cy, ty: 0,
            // 목록(#pl-track-list) 밖으로 나가지 못하게 하는 이동 범위
            min: tops[0] - tops[from],
            max: (tops[last] + hs[last]) - hs[from] - tops[from],
            raf: 0, timer: 0, autoV: 0
        };
        row.classList.add('dragging');
        rows.forEach(r => { r._ty = 0; });
        buzz(8);
        schedule();
    }
    function schedule() { if (drag && !drag.raf) drag.raf = requestAnimationFrame(frame); }

    /** 끌고 있는 행의 앞 가장자리가 이웃 행의 중심을 지나면 자리를 바꾼다(고정된 원래 중심 기준 + 히스테리시스 → 떨림 없음) */
    function computeTarget(ty) {
        const d = drag, top = d.tops[d.from] + ty, bot = top + d.hs[d.from];
        const bias = 8;
        let to = d.from;
        const botEff = bot + (d.to > d.from ? bias : 0);
        for (let i = d.from + 1; i < d.rows.length; i++) {
            if (d.tops[i] + d.hs[i] / 2 < botEff) to = i; else break;
        }
        const topEff = top - (d.to < d.from ? bias : 0);
        for (let i = d.from - 1; i >= 0; i--) {
            if (d.tops[i] + d.hs[i] / 2 > topEff) to = i; else break;
        }
        return to;
    }

    /** 새 순서의 레이아웃을 계산해 다른 행을 translateY 로 옮긴다. 가까운 행부터 순차적으로(스태거) 이동 → 겹침 없음 */
    function applyOrder() {
        const d = drag;
        const order = d.rows.slice();
        order.splice(d.from, 1); order.splice(d.to, 0, d.row);
        let y = d.tops[0];
        order.forEach(r => { d.newTop.set(r, y); y += d.hmap.get(r); });
        d.rows.forEach((r, i) => {
            if (r === d.row) return;
            const dy = Math.round((d.newTop.get(r) - d.tops[i]) * 10) / 10;
            if (r._ty === dy) return;
            r._ty = dy;
            const delay = Math.min(Math.abs(i - d.from) - 1, 5) * 22;
            r.style.transition = 'transform .3s ' + EASE + ' ' + Math.max(0, delay) + 'ms';
            r.style.transform = dy ? 'translate3d(0,' + dy + 'px,0)' : '';
        });
    }

    function frame() {
        const d = drag; if (!d) return;
        d.raf = 0;
        // 화면 가장자리에서 자동 스크롤 (손가락을 가만히 두어도 계속 이동)
        const edgeT = 96, edgeB = innerHeight - DOCK_SAFE;
        let v = 0;
        if (d.cy < edgeT) v = -Math.ceil((edgeT - d.cy) / edgeT * 14);
        else if (d.cy > edgeB) v = Math.ceil(Math.min(1, (d.cy - edgeB) / 90) * 14);
        d.autoV = v;
        if (v) window.scrollBy(0, v);
        const ty = clamp((d.cy + (window.scrollY || 0)) - (d.startClientY + d.startScroll), d.min, d.max);
        d.ty = ty;
        d.row.style.transform = 'translate3d(0,' + ty + 'px,0) scale(1.025)';
        const to = computeTarget(ty);
        if (to !== d.to) { d.to = to; applyOrder(); }
        if (d.autoV) schedule();
    }

    function endDrag() {
        const d = drag; if (!d) return;
        cancelAnimationFrame(d.raf); d.raf = 0;
        suppress(450);
        settling = true;
        if (!d.newTop.size) applyOrder();   // 이동 없이 놓은 경우에도 맵 보장
        const finalTop = d.newTop.get(d.row) != null ? d.newTop.get(d.row) : d.tops[d.from];
        const settleY = finalTop - d.tops[d.from];
        d.row.classList.remove('dragging');
        d.row.classList.add('settling');
        d.row.style.transition = 'transform .26s ' + EASE;
        d.row.style.transform = 'translate3d(0,' + settleY + 'px,0) scale(1.02)';
        d.timer = setTimeout(() => commit(d), 280);
    }

    /** 안착이 끝난 뒤 데이터/DOM 을 한 번에 확정한다. 이미 보이는 위치와 같으므로 시각적 점프가 없다. */
    function commit(d) {
        if (drag !== d) return;
        drag = null;
        const row = d.row;
        if (d.to !== d.from && row.isConnected) {
            const pl = (typeof plById === 'function') ? plById(E.plId) : null;
            if (pl && pl.tracks[d.from] && pl.tracks[d.from].id === row.dataset.id) {
                const before = pl.tracks.map(t => t.id);
                const moved = pl.tracks.splice(d.from, 1)[0];
                pl.tracks.splice(d.to, 0, moved);
                plSave();
                syncQueueAfterReorder(before, pl.tracks);
                if (Math.min(d.from, d.to) < 4) refreshCover(pl);
            }
            // DOM: 끌던 행만 옮긴다 (전체 재렌더 없음 → 이미지 깜빡임/스크롤 위치 변화 없음)
            const ref = d.to > d.from ? d.rows[d.to].nextSibling : d.rows[d.to];
            list.insertBefore(row, ref);
        }
        // 모든 행의 임시 transform/transition 제거 — 같은 프레임에서 일어나므로 위치 변화 없음
        d.rows.forEach(r => {
            r.style.transition = 'none'; r.style.transform = ''; delete r._ty;
        });
        row.classList.remove('settling');
        // 번호 갱신 (영향 받은 구간만)
        const now = rowsOf(), a = Math.min(d.from, d.to), b = Math.max(d.from, d.to);
        for (let i = a; i <= b && i < now.length; i++) {
            const n = now[i].querySelector('.pl-track-num'); if (n) n.textContent = i + 1;
        }
        void list.offsetHeight;          // transition:none 이 적용된 상태로 레이아웃 확정
        d.rows.forEach(r => { r.style.transition = ''; });
        settling = false;
        if (E.active) showMenu(60);      // 새 위치에서 메뉴 다시 표시
    }

    function cancelDrag() {
        const d = drag; if (!d) return;
        drag = null;
        cancelAnimationFrame(d.raf); clearTimeout(d.timer);
        d.rows.forEach(r => { r.style.transition = ''; r.style.transform = ''; delete r._ty; });
        d.row.classList.remove('dragging', 'settling');
        settling = false;
    }

    /** 재생 큐가 이 플레이리스트와 같은 구성/순서였다면 새 순서를 따라가게 한다(현재 곡 인덱스 유지). */
    function syncQueueAfterReorder(beforeIds, newTracks) {
        try {
            if (S.q.length !== beforeIds.length) return;
            for (let i = 0; i < beforeIds.length; i++) if (S.q[i].id !== beforeIds[i]) return;
            S.q = newTracks.slice();
            const i = S.track ? S.q.findIndex(t => t.id === S.track.id) : -1;
            if (i >= 0) S.idx = i;
            renderQueue();
        } catch (e) { }
    }
    function refreshCover(pl) {
        const cover = $('pl-detail-cover'); if (!cover || !pl.tracks.length) return;
        const thumbs = pl.tracks.slice(0, 4).map(t => trackThumbSrc(t));
        cover.className = 'pl-detail-cover' + (thumbs.length === 1 ? ' single' : '');
        cover.innerHTML = thumbs.map(src => `<img src="${esc(src)}" alt="">`).join('');
    }

    /* ───────── 입력 처리 (터치 + 마우스) ───────── */
    function cancelPress() {
        if (press && press.timer) clearTimeout(press.timer);
        press = null;
    }
    function firePress() {
        const p = press; if (!p || p.fired) return;
        p.fired = true;
        suppress(700);
        enter(p.row);
    }
    function down(e, x, y) {
        if (settling || drag) return;
        const t = e.target;
        if (!t || !t.closest) return;
        const row = t.closest('.pl-track');
        if (!row || !list.contains(row)) return;
        if (t.closest('.pl-track-del')) return;        // 기존 삭제(X) 버튼은 그대로
        const base = { row, x, y, sy: window.scrollY || 0, fired: false, timer: 0, immediate: false };
        if (E.active && row === E.row) {
            base.immediate = true;                       // 이미 edit 중인 행: 바로 끌 수 있다
        } else {
            base.timer = setTimeout(firePress, LONG_MS);
        }
        press = base;
    }
    function move(e, x, y) {
        if (drag) {
            if (e.cancelable) e.preventDefault();
            drag.cx = x; drag.cy = y; schedule();
            return;
        }
        const p = press; if (!p) return;
        const dx = x - p.x, dy = y - p.y;
        if (p.fired || p.immediate) {
            if (e.cancelable) e.preventDefault();        // 스크롤 대신 드래그
            if (Math.abs(dy) > DRAG_START || Math.abs(dx) > DRAG_START) {
                if (!E.active || E.row !== p.row) enter(p.row);
                startDrag(p, x, y);
                press = null;
            }
            return;
        }
        if (Math.hypot(dx, dy) > SLOP) cancelPress();    // 롱프레스 전에 움직였다 → 일반 스크롤
    }
    function up() {
        if (drag) { endDrag(); return; }
        const p = press; cancelPress();
        if (p && p.fired) suppress(450);
    }

    list.addEventListener('touchstart', e => {
        lastTouchAt = Date.now();
        if (e.touches.length !== 1) { cancelPress(); return; }
        down(e, e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });
    list.addEventListener('touchmove', e => {
        lastTouchAt = Date.now();
        if (e.touches.length !== 1) return;
        move(e, e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: false });                              // preventDefault 로 드래그 중 스크롤을 막아야 한다
    list.addEventListener('touchend', () => { lastTouchAt = Date.now(); up(); }, { passive: true });
    list.addEventListener('touchcancel', () => {
        lastTouchAt = Date.now();
        if (drag) endDrag(); else cancelPress();
    }, { passive: true });

    list.addEventListener('mousedown', e => {            // 브라우저(마우스) 폴백
        if (e.button !== 0 || Date.now() - lastTouchAt < 700) return;
        down(e, e.clientX, e.clientY);
    });
    document.addEventListener('mousemove', e => {
        if (Date.now() - lastTouchAt < 700 || (!press && !drag)) return;
        move(e, e.clientX, e.clientY);
    });
    document.addEventListener('mouseup', () => {
        if (Date.now() - lastTouchAt < 700 || (!press && !drag)) return;
        up();
    });

    // 길게 누를 때 뜨는 시스템 컨텍스트 메뉴/텍스트 선택 방지
    list.addEventListener('contextmenu', e => e.preventDefault());

    /* 롱프레스/드래그 직후의 click 무시 + edit 상태에서 바깥을 누르면 해제 */
    document.addEventListener('click', e => {
        const t = e.target;
        if (!t || !t.closest) return;
        if (Date.now() < suppressUntil && t.closest('#pl-track-list')) { e.stopPropagation(); e.preventDefault(); return; }
        if (!E.active) return;
        if (t.closest('#pl-edit-menu')) return;
        if (t.closest('.pl-track.editing')) { e.stopPropagation(); e.preventDefault(); return; }   // edit 행 탭: 재생하지 않음
        if (t.closest('#v-playlists')) { e.stopPropagation(); e.preventDefault(); }                // 이 탭은 해제에만 쓴다
        exit();
    }, true);

    /* 스크롤: 메뉴는 숨겼다가 스크롤이 멈추면 행의 새 위치에 다시 나타난다 */
    window.addEventListener('scroll', () => {
        if (!E.active || drag || settling) return;
        const m = menuEl();
        if (m && m.classList.contains('on')) m.classList.remove('on');
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(() => { if (E.active && !drag && !settling) showMenu(0); }, 140);
    }, { passive: true, capture: true });   // capture: 문서 스크롤뿐 아니라 내부 스크롤 컨테이너도 감지
    ['resize', 'orientationchange'].forEach(ev => window.addEventListener(ev, () => {
        if (E.active && !drag) { hideMenu(); showMenu(200); }
    }, { passive: true }));
})();
