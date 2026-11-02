'use strict';

(() => {
    const $ = (id) => document.getElementById(id);
    const hasHostApi = Boolean(window.hostAPI);

    const DEMO_VIDEO = {
        videoId: 'aqz-KE-bpKQ',
        url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
        title: 'Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film',
        channel: 'Blender',
        duration: 635,
        fps: 60,
        width: 3840,
        height: 2160,
        thumbnail: 'https://i.ytimg.com/vi/aqz-KE-bpKQ/hqdefault.jpg'
    };

    const state = {
        boot: null,
        settings: {},
        library: [],
        tools: null,
        hostState: { connected: false },
        video: null,
        duration: 0,
        currentTime: 0,
        inPoint: 0,
        outPoint: 0,
        playerReady: false,
        playerBlocked: false,
        playing: false,
        lastPosition: 0,
        lastInfoAt: 0,
        ytIframe: null,
        ytMessageHandler: null,
        ytHandshakeTimer: null,
        ytHandshakeCount: 0,
        loading: false,
        preparing: false,
        cancelRequested: false,
        jobId: null,
        preparedClip: null,
        draggingId: null,
        progress: null,
        modalOpen: false,
        dragMode: null,
        demo: !hasHostApi && /(?:^|[?&])demo=1(?:&|$)/.test(location.search)
    };

    const api = window.hostAPI || createMockApi();
    const els = {};
    const FRAME_MIN_GAP = 2;

    let initialized = false;
    document.addEventListener('DOMContentLoaded', init);
    if (document.readyState !== 'loading') init();

    async function init() {
        if (initialized) return;
        initialized = true;
        cacheElements();
        bindEvents();
        configureMockState();

        try {
            const boot = unwrap(await api.getBootData());
            state.boot = boot;
            state.settings = {
                maxHeight: 1080,
                binName: 'Web Clips',
                trackIndex: 1,
                insertMode: 'playhead',
                ...(boot.settings || {})
            };
            state.library = boot.library || [];
            state.tools = boot.tools || null;
            state.hostState = boot.hostState || { connected: false };
            $('appVersion').textContent = `v${boot.version || '1.0.0'}`;
        } catch (error) {
            toast(error.message || 'Could not load plugin settings.', 'error', 7000);
            state.settings = { maxHeight: 1080, binName: 'Web Clips', trackIndex: 1, insertMode: 'playhead' };
        }

        updateHostStatus();
        updateVideoCard();
        updateRangeUI();
        renderLibrary();
        refreshCacheStats();
        updateToolsUI();

        if (state.demo) {
            setVideo(DEMO_VIDEO);
        }

        setInterval(tickPlayhead, 80);
        setInterval(() => refreshHostState(true), 15000);
    }

    function cacheElements() {
        const ids = [
            'urlInput', 'loadBtn', 'clearUrlBtn', 'settingsBtn', 'hostPill', 'hostPillText',
            'projectInfo', 'fpsInfo', 'refreshStateBtn', 'playerMount', 'ytHost', 'playerEmpty',
            'playerPoster', 'posterImg', 'posterTitle', 'posterText', 'openSourceSiteBtn',
            'playerOverlay', 'playerOverlayText', 'playerBadge', 'stepBackBtn', 'playBtn',
            'stepFwdBtn', 'currentTc', 'durationTc', 'embedState', 'openSourceBtn', 'rangeBar',
            'rangeFill', 'rangeTicks', 'playhead', 'inHandle', 'outHandle', 'inTc', 'outTc',
            'rangeDuration', 'rangeHint', 'setInBtn', 'setOutBtn', 'goInBtn', 'goOutBtn',
            'clearMarksBtn', 'videoCard', 'videoThumb', 'videoDurationBadge', 'videoTitle',
            'videoChannel', 'videoResolution', 'videoFps', 'videoSourceFps', 'rangeStateBadge',
            'panelIn', 'panelOut', 'panelDuration', 'panelFrames', 'prepareBtn', 'cancelBtn',
            'progressPanel', 'progressLabel', 'progressPercent', 'progressFill', 'progressDetail',
            'readyPanel', 'readyText', 'insertBtn', 'binBtn', 'libraryGrid', 'librarySub',
            'cacheSize', 'openCacheBtn', 'toastStack', 'settingsModal', 'closeSettingsBtn',
            'maxHeightSelect', 'binNameInput', 'trackSelect', 'settingsCacheSize',
            'cachePath', 'settingsOpenCacheBtn', 'settingsClearCacheBtn', 'toolsState',
            'ytdlpVersion', 'ffmpegVersion', 'ffmpegState', 'updateYtDlpBtn', 'saveSettingsBtn',
            'settingsHostState', 'settingsHostInfo', 'appVersion'
        ];
        ids.forEach((id) => { els[id] = $(id); });
    }

    function bindEvents() {
        els.loadBtn.addEventListener('click', loadVideo);
        els.urlInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') loadVideo();
        });
        els.urlInput.addEventListener('input', () => {
            els.clearUrlBtn.classList.toggle('hidden', !els.urlInput.value.trim());
        });
        els.clearUrlBtn.addEventListener('click', () => {
            els.urlInput.value = '';
            els.clearUrlBtn.classList.add('hidden');
            els.urlInput.focus();
        });
        els.settingsBtn.addEventListener('click', openSettings);
        els.closeSettingsBtn.addEventListener('click', closeSettings);
        document.querySelectorAll('[data-close-modal]').forEach((node) => node.addEventListener('click', closeSettings));
        els.saveSettingsBtn.addEventListener('click', saveSettings);
        els.settingsOpenCacheBtn.addEventListener('click', openCacheFolder);
        els.settingsClearCacheBtn.addEventListener('click', clearCache);
        els.openCacheBtn.addEventListener('click', openCacheFolder);
        els.updateYtDlpBtn.addEventListener('click', updateYtDlp);
        els.refreshStateBtn.addEventListener('click', () => refreshHostState(false, true));

        els.playBtn.addEventListener('click', togglePlayback);
        els.stepBackBtn.addEventListener('click', () => stepFrames(-1));
        els.stepFwdBtn.addEventListener('click', () => stepFrames(1));
        els.setInBtn.addEventListener('click', () => setInPoint(state.currentTime));
        els.setOutBtn.addEventListener('click', () => setOutPoint(state.currentTime));
        els.goInBtn.addEventListener('click', () => seekTo(state.inPoint, true));
        els.goOutBtn.addEventListener('click', () => seekTo(state.outPoint, true));
        els.clearMarksBtn.addEventListener('click', resetMarks);
        els.prepareBtn.addEventListener('click', prepareClip);
        els.cancelBtn.addEventListener('click', cancelPrepare);
        els.insertBtn.addEventListener('click', () => insertRecord(state.preparedClip));
        els.binBtn.addEventListener('click', () => addToBin(state.preparedClip));
        els.openSourceBtn.addEventListener('click', openSourcePage);
        els.openSourceSiteBtn.addEventListener('click', openSourcePage);

        els.rangeBar.addEventListener('pointerdown', onRangeBarPointerDown);
        els.inHandle.addEventListener('pointerdown', (event) => beginHandleDrag('in', event));
        els.outHandle.addEventListener('pointerdown', (event) => beginHandleDrag('out', event));
        els.inHandle.addEventListener('keydown', (event) => onHandleKeyDown('in', event));
        els.outHandle.addEventListener('keydown', (event) => onHandleKeyDown('out', event));

        els.libraryGrid.addEventListener('click', onLibraryClick);
        els.libraryGrid.addEventListener('dragstart', onLibraryDragStart);
        els.libraryGrid.addEventListener('dragend', onLibraryDragEnd);

        document.addEventListener('keydown', onGlobalKeyDown);
        api.onProgress(onProgress);
        api.onLog((line) => console.log('[main]', line));
    }

    /* ------------------------------------------------------------------ */
    /* Helpers                                                             */
    /* ------------------------------------------------------------------ */

    function unwrap(result) {
        if (result == null) throw new Error('No response from the plugin backend.');
        if (result.ok === false) throw new Error(result.error || 'Unknown error.');
        return Object.prototype.hasOwnProperty.call(result, 'ok') ? result.data : result;
    }

    function fps() {
        const value = Number(state.hostState && state.hostState.fps);
        return Number.isFinite(value) && value > 0 ? value : 24;
    }

    function projectFpsLabel() {
        return Number.isInteger(fps()) ? `${fps()} fps` : `${fps().toFixed(2)} fps`;
    }

    function formatTC(seconds) {
        const value = Math.max(0, Number(seconds) || 0);
        const nominal = Math.max(1, Math.round(fps()));
        const totalFrames = Math.round(value * fps());
        const frames = totalFrames % nominal;
        const totalSeconds = Math.floor(totalFrames / nominal);
        const h = Math.floor(totalSeconds / 3600);
        const m = Math.floor((totalSeconds % 3600) / 60);
        const s = totalSeconds % 60;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(frames).padStart(2, '0')}`;
    }

    function formatShortTime(seconds) {
        const value = Math.max(0, Number(seconds) || 0);
        const total = Math.floor(value);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }

    function formatBytes(bytes) {
        const value = Number(bytes) || 0;
        if (value < 1024) return `${value} B`;
        if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
        if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
        return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }

    function rangeFrames() {
        return Math.max(0, Math.round((state.outPoint - state.inPoint) * fps()));
    }

    function rangeDuration() {
        return Math.max(0, state.outPoint - state.inPoint);
    }

    function minGap() {
        return FRAME_MIN_GAP / fps();
    }

    function snapTime(seconds) {
        return Math.max(0, Math.round((Number(seconds) || 0) * fps()) / fps());
    }

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function toast(message, type = 'info', timeout = 5200) {
        const node = document.createElement('div');
        node.className = `toast ${type}`;
        const icon = makeIcon(type === 'success' ? 'i-check' : type === 'error' ? 'i-x' : 'i-film');
        const text = document.createElement('div');
        text.textContent = message;
        node.append(icon, text);
        els.toastStack.appendChild(node);
        setTimeout(() => {
            node.style.opacity = '0';
            node.style.transform = 'translateY(4px)';
            node.style.transition = 'opacity .2s, transform .2s';
            setTimeout(() => node.remove(), 220);
        }, timeout);
    }

    function makeIcon(id) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        use.setAttribute('href', `#${id}`);
        svg.appendChild(use);
        return svg;
    }

    /* ------------------------------------------------------------------ */
    /* Embedded preview (postMessage API, no remote script)                */
    /* ------------------------------------------------------------------ */

    function destroyPlayer() {
        if (state.ytMessageHandler) {
            window.removeEventListener('message', state.ytMessageHandler);
            state.ytMessageHandler = null;
        }
        if (state.ytHandshakeTimer) {
            clearInterval(state.ytHandshakeTimer);
            state.ytHandshakeTimer = null;
        }
        state.ytIframe = null;
        state.playerReady = false;
        state.playerBlocked = false;
        state.playing = false;
        els.ytHost.replaceChildren();
    }

    function createPlayer(video) {
        destroyPlayer();
        hidePoster();
        els.playerEmpty.classList.add('hidden');
        els.playerBadge.classList.add('hidden');
        els.ytHost.classList.remove('hidden');

        const iframe = document.createElement('iframe');
        iframe.id = 'ytPlayerFrame';
        iframe.title = video.title;
        iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
        iframe.referrerPolicy = 'strict-origin-when-cross-origin';
        iframe.src = `https://www.youtube.com/embed/${encodeURIComponent(video.videoId)}?enablejsapi=1&controls=0&rel=0&modestbranding=1&playsinline=1&iv_load_policy=3&disablekb=1&fs=0&autoplay=0`;

        state.ytIframe = iframe;
        els.ytHost.replaceChildren(iframe);

        state.ytMessageHandler = (event) => handlePlayerMessage(event);
        window.addEventListener('message', state.ytMessageHandler);

        iframe.addEventListener('load', () => {
            handshakePlayer();
            state.ytHandshakeCount = 0;
            state.ytHandshakeTimer = setInterval(() => {
                state.ytHandshakeCount += 1;
                if (state.playerReady || state.playerBlocked || state.ytHandshakeCount > 20) {
                    clearInterval(state.ytHandshakeTimer);
                    state.ytHandshakeTimer = null;
                    return;
                }
                handshakePlayer();
            }, 500);
        });

        showOverlay('Loading video preview…');
    }

    function handshakePlayer() {
        postPlayer({ event: 'listening', id: 'ytPlayerFrame', channel: 'widget' });
    }

    function postPlayer(payload) {
        const iframe = state.ytIframe;
        if (!iframe || !iframe.contentWindow) return;
        try {
            iframe.contentWindow.postMessage(JSON.stringify(payload), '*');
        } catch { /* iframe may still be loading */ }
    }

    function playerCommand(func, args = []) {
        postPlayer({ event: 'command', func, args, id: 'ytPlayerFrame', channel: 'widget' });
    }

    function handlePlayerMessage(event) {
        if (!state.ytIframe || event.source !== state.ytIframe.contentWindow) return;
        const origin = String(event.origin || '');
        if (!/(^|\.)youtube\.com$/.test(origin.replace(/^https?:\/\//, ''))) return;

        let payload = event.data;
        if (typeof payload === 'string') {
            try { payload = JSON.parse(payload); } catch { return; }
        }
        if (!payload || !payload.event) return;

        if (payload.event === 'onReady' || payload.event === 'initialDelivery') {
            markPlayerReady();
            if (payload.info) handlePlayerInfo(payload.info);
            return;
        }

        if (payload.event === 'infoDelivery') {
            if (!state.playerReady) markPlayerReady();
            handlePlayerInfo(payload.info);
            return;
        }

        if (payload.event === 'onStateChange') {
            const playerState = typeof payload.info === 'number' ? payload.info : null;
            if (playerState != null) {
                state.playing = playerState === 1;
                if (playerState === 0) state.playing = false;
                updatePlayButton();
            }
            return;
        }

        if (payload.event === 'onError') {
            const code = Number(payload.info);
            const messages = {
                2: 'That video ID is invalid.',
                5: 'The HTML5 player could not start.',
                100: 'That video is private or has been removed.',
                101: 'The owner does not allow this video to be embedded.',
                150: 'The owner does not allow this video to be embedded.'
            };
            showPoster('Preview blocked by the source site', messages[code] || 'The source site refused embedded playback for this video.');
            return;
        }
    }

    function markPlayerReady() {
        if (state.playerReady) return;
        state.playerReady = true;
        state.lastInfoAt = performance.now();
        if (state.ytHandshakeTimer) {
            clearInterval(state.ytHandshakeTimer);
            state.ytHandshakeTimer = null;
        }
        hideOverlay();
        hidePoster();
        els.playerBadge.classList.remove('hidden');
        els.embedState.textContent = 'Preview ready';
        updatePlayButton();
    }

    function handlePlayerInfo(info) {
        if (!info) return;
        if (typeof info.duration === 'number' && info.duration > 0) {
            const oldDuration = state.duration;
            state.duration = info.duration;
            if (state.outPoint >= oldDuration - 0.05) state.outPoint = state.duration;
            if (state.inPoint > state.duration) state.inPoint = Math.max(0, state.duration - minGap());
            state.outPoint = clamp(state.outPoint, state.inPoint + minGap(), state.duration);
            updateRangeUI();
        }
        if (typeof info.currentTime === 'number') {
            state.lastPosition = info.currentTime;
            state.lastInfoAt = performance.now();
            if (!state.playing) {
                state.currentTime = info.currentTime;
                updateTimecode();
                updatePlayhead();
            }
        }
        if (typeof info.playerState === 'number') {
            state.playing = info.playerState === 1;
            updatePlayButton();
        }
    }

    function showOverlay(text) {
        els.playerOverlayText.textContent = text;
        els.playerOverlay.classList.remove('hidden');
    }

    function hideOverlay() {
        els.playerOverlay.classList.add('hidden');
    }

    function showPoster(title, detail) {
        if (state.ytHandshakeTimer) {
            clearInterval(state.ytHandshakeTimer);
            state.ytHandshakeTimer = null;
        }
        state.playerBlocked = true;
        state.playerReady = false;
        state.playing = false;
        hideOverlay();
        els.playerBadge.classList.add('hidden');
        els.playerEmpty.classList.add('hidden');
        els.playerPoster.classList.remove('hidden');
        els.posterImg.src = state.video ? state.video.thumbnail : '';
        els.posterTitle.textContent = title || 'Preview unavailable';
        els.posterText.textContent = detail || 'This video does not allow embedded playback.';
        els.embedState.textContent = 'Embedded preview unavailable';
        updatePlayButton();
    }

    function hidePoster() {
        els.playerPoster.classList.add('hidden');
    }

    /* ------------------------------------------------------------------ */
    /* Video loading                                                       */
    /* ------------------------------------------------------------------ */

    async function loadVideo() {
        const raw = els.urlInput.value.trim();
        if (!raw) {
            els.urlInput.focus();
            toast('Paste a video link first.', 'info');
            return;
        }
        if (state.loading) return;

        state.loading = true;
        els.loadBtn.disabled = true;
        els.loadBtn.textContent = 'Loading…';
        showOverlay('Reading video information…');
        els.playerEmpty.classList.add('hidden');

        try {
            const video = unwrap(await api.loadVideo(raw));
            setVideo(video);
            toast('Video loaded. Set your In and Out points.', 'success');
        } catch (error) {
            hideOverlay();
            if (!state.video) els.playerEmpty.classList.remove('hidden');
            toast(cleanError(error), 'error', 8000);
        } finally {
            state.loading = false;
            els.loadBtn.disabled = false;
            els.loadBtn.textContent = 'Load video';
        }
    }

    function setVideo(video) {
        destroyPlayer();
        state.video = video;
        state.duration = Math.max(0, Number(video.duration) || 0);
        state.currentTime = 0;
        state.lastPosition = 0;
        state.inPoint = 0;
        state.outPoint = state.duration;
        state.preparedClip = null;
        state.playerBlocked = false;
        state.playing = false;

        els.urlInput.value = video.url || `https://www.youtube.com/watch?v=${video.videoId}`;
        els.clearUrlBtn.classList.remove('hidden');
        hidePoster();
        hideOverlay();
        showPlayerSurface();
        updateVideoCard();
        updateRangeUI();
        updatePrepareState();
        updatePlayButton();
        createPlayer(video);
        refreshHostState(true);
    }

    function showPlayerSurface() {
        els.playerEmpty.classList.add('hidden');
        els.playerPoster.classList.add('hidden');
        els.ytHost.classList.remove('hidden');
        els.playerBadge.classList.add('hidden');
    }

    function updateVideoCard() {
        const video = state.video;
        if (!video) {
            els.videoCard.classList.add('is-empty');
            els.videoTitle.textContent = 'No video loaded';
            els.videoChannel.textContent = 'Paste a video link above.';
            els.videoThumb.removeAttribute('src');
            els.videoDurationBadge.textContent = '—';
            els.videoResolution.textContent = '—';
            els.videoFps.textContent = '—';
            els.videoSourceFps.textContent = '—';
            els.openSourceBtn.classList.add('hidden');
            els.embedState.textContent = 'No video loaded';
            return;
        }
        els.videoCard.classList.remove('is-empty');
        els.videoTitle.textContent = video.title;
        els.videoChannel.textContent = video.channel || 'Web video';
        els.videoThumb.src = video.thumbnail;
        els.videoDurationBadge.textContent = formatShortTime(video.duration);
        els.videoResolution.textContent = `${video.width || '?'}×${video.height || '?'}`;
        els.videoFps.textContent = `${Number(video.fps) || 30} fps source`;
        els.videoSourceFps.textContent = `${projectFpsLabel()} project`;
        els.openSourceBtn.classList.remove('hidden');
    }

    function updatePlayButton() {
        const icon = els.playBtn.querySelector('use');
        if (icon) icon.setAttribute('href', state.playing ? '#i-pause' : '#i-play');
        els.playBtn.disabled = !state.playerReady || state.playerBlocked;
        els.playBtn.title = state.playing ? 'Pause (Space)' : 'Play (Space)';
    }

    function tickPlayhead() {
        if (!state.playerReady || state.playerBlocked) return;
        if (state.playing) {
            const elapsed = Math.max(0, (performance.now() - state.lastInfoAt) / 1000);
            state.currentTime = Math.min(state.duration, state.lastPosition + elapsed);
            updateTimecode();
            updatePlayhead();
        }
    }

    function updateTimecode() {
        els.currentTc.textContent = formatTC(state.currentTime);
        els.durationTc.textContent = formatTC(state.duration);
    }

    function togglePlayback() {
        if (!state.playerReady || state.playerBlocked) {
            toast('The preview player is not ready.', 'info');
            return;
        }
        if (state.playing) {
            playerCommand('pauseVideo');
            state.playing = false;
        } else {
            playerCommand('playVideo');
            state.playing = true;
            state.lastPosition = state.currentTime;
            state.lastInfoAt = performance.now();
        }
        updatePlayButton();
    }

    function seekTo(seconds, playIfPaused = false) {
        const target = clamp(Number(seconds) || 0, 0, state.duration || 0);
        state.currentTime = target;
        state.lastPosition = target;
        state.lastInfoAt = performance.now();
        if (state.playerReady && !state.playerBlocked) {
            playerCommand('seekTo', [target, true]);
            if (playIfPaused && !state.playing) {
                playerCommand('playVideo');
                state.playing = true;
                updatePlayButton();
            }
        }
        updateTimecode();
        updatePlayhead();
        updateRangeHint();
    }

    function stepFrames(direction, amount = 1) {
        seekTo(state.currentTime + (direction * amount) / fps());
    }

    /* ------------------------------------------------------------------ */
    /* Range UI                                                            */
    /* ------------------------------------------------------------------ */

    function rangePercent(seconds) {
        if (!state.duration) return 0;
        return clamp((seconds / state.duration) * 100, 0, 100);
    }

    function updateRangeUI() {
        const hasVideo = Boolean(state.video);
        const inPct = rangePercent(state.inPoint);
        const outPct = rangePercent(state.outPoint);

        els.rangeFill.style.left = `${inPct}%`;
        els.rangeFill.style.width = `${Math.max(0, outPct - inPct)}%`;
        els.inHandle.style.left = `${inPct}%`;
        els.outHandle.style.left = `${outPct}%`;
        els.inHandle.style.display = hasVideo ? '' : 'none';
        els.outHandle.style.display = hasVideo ? '' : 'none';
        els.rangeFill.style.display = hasVideo ? '' : 'none';

        const inText = formatTC(state.inPoint);
        const outText = formatTC(state.outPoint);
        els.inTc.textContent = inText;
        els.outTc.textContent = outText;
        els.panelIn.textContent = inText;
        els.panelOut.textContent = outText;
        els.panelDuration.textContent = formatTC(rangeDuration());
        els.panelFrames.textContent = rangeFrames().toLocaleString();
        els.rangeDuration.textContent = `${rangeFrames().toLocaleString()} frames`;
        els.rangeHint.textContent = hasVideo ? 'Drag the green and amber handles, or use I and O' : 'Set an In and Out point with I and O';

        const status = getRangeStatus();
        els.rangeStateBadge.textContent = status.label;
        els.rangeStateBadge.className = `badge ${status.className || ''}`.trim();
        updatePrepareState();
        updateRangeHint();
    }

    function updateRangeHint() {
        if (!state.video) return;
        const t = state.currentTime;
        if (Math.abs(t - state.inPoint) < 0.5 / fps()) {
            els.rangeHint.textContent = 'Playhead is at the In point';
        } else if (Math.abs(t - state.outPoint) < 0.5 / fps()) {
            els.rangeHint.textContent = 'Playhead is at the Out point';
        } else if (t < state.inPoint) {
            els.rangeHint.textContent = 'Before the In point';
        } else if (t > state.outPoint) {
            els.rangeHint.textContent = 'After the Out point';
        } else {
            els.rangeHint.textContent = `${formatShortTime(state.outPoint - t)} inside the range`;
        }
    }

    function getRangeStatus() {
        if (!state.video) return { label: 'Not set', className: '' };
        if (state.preparing) return { label: 'Preparing', className: 'warn' };
        if (state.preparedClip && rangeMatches()) return { label: 'Ready', className: 'ok' };
        if (state.preparedClip && !rangeMatches()) return { label: 'Range changed', className: 'warn' };
        return { label: 'Unprepared', className: '' };
    }

    function rangeMatches() {
        const clip = state.preparedClip;
        const video = state.video;
        if (!clip || !video) return false;
        if (clip.videoId !== video.videoId) return false;
        if (Math.abs(Number(clip.start) - state.inPoint) > 0.02) return false;
        if (Math.abs(Number(clip.end) - state.outPoint) > 0.02) return false;
        if (clip.maxHeight && Number(clip.maxHeight) !== Number(state.settings.maxHeight)) return false;
        return true;
    }

    function updatePrepareState() {
        const canPrepare = Boolean(state.video) && rangeDuration() >= minGap() && !state.preparing;
        const matches = Boolean(state.preparedClip) && rangeMatches();
        const readyVisible = Boolean(matches && state.preparedClip && state.preparedClip.exists !== false);

        els.prepareBtn.disabled = !canPrepare || matches;
        els.cancelBtn.classList.toggle('hidden', !state.preparing);
        els.readyPanel.classList.toggle('hidden', !readyVisible);

        if (readyVisible) {
            const clip = state.preparedClip;
            els.readyText.textContent = `${formatShortTime(clip.duration)} · ${rangeFrames().toLocaleString()} frames · ${formatBytes(clip.size)}`;
        }

        if (state.preparing) {
            els.prepareBtn.classList.add('hidden');
        } else {
            els.prepareBtn.classList.toggle('hidden', readyVisible);
        }
    }

    function markRangeChanged() {
        updateRangeUI();
        updatePrepareState();
    }

    function setInPoint(seconds) {
        if (!state.video) return;
        const value = snapTime(clamp(seconds, 0, Math.max(0, state.outPoint - minGap())));
        state.inPoint = Math.min(value, Math.max(0, state.outPoint - minGap()));
        if (state.outPoint - state.inPoint < minGap()) {
            state.outPoint = Math.min(state.duration, state.inPoint + minGap());
        }
        markRangeChanged();
    }

    function setOutPoint(seconds) {
        if (!state.video) return;
        const value = snapTime(clamp(seconds, state.inPoint + minGap(), state.duration));
        state.outPoint = Math.max(value, state.inPoint + minGap());
        markRangeChanged();
    }

    function resetMarks() {
        if (!state.video) return;
        state.inPoint = 0;
        state.outPoint = state.duration;
        markRangeChanged();
        seekTo(0);
    }

    function onRangeBarPointerDown(event) {
        if (!state.video) return;
        if (event.target.closest('.range-handle')) return;
        seekFromPointer(event);
    }

    function seekFromPointer(event) {
        const rect = els.rangeBar.getBoundingClientRect();
        const fraction = clamp((event.clientX - rect.left) / rect.width, 0, 1);
        seekTo(fraction * state.duration);
    }

    function beginHandleDrag(which, event) {
        if (!state.video) return;
        event.preventDefault();
        event.stopPropagation();
        state.dragMode = which;
        els.rangeBar.setPointerCapture?.(event.pointerId);
        updateHandleFromPointer(event);
        document.addEventListener('pointermove', onHandlePointerMove);
        document.addEventListener('pointerup', endHandleDrag);
    }

    function onHandlePointerMove(event) {
        if (!state.dragMode) return;
        updateHandleFromPointer(event);
    }

    function updateHandleFromPointer(event) {
        const rect = els.rangeBar.getBoundingClientRect();
        const fraction = clamp((event.clientX - rect.left) / rect.width, 0, 1);
        const value = snapTime(fraction * state.duration);
        if (state.dragMode === 'in') {
            setInPoint(value);
            seekTo(state.inPoint);
        } else if (state.dragMode === 'out') {
            setOutPoint(value);
            seekTo(state.outPoint);
        }
    }

    function endHandleDrag() {
        state.dragMode = null;
        document.removeEventListener('pointermove', onHandlePointerMove);
        document.removeEventListener('pointerup', endHandleDrag);
    }

    function onHandleKeyDown(which, event) {
        if (!state.video) return;
        const step = (event.shiftKey ? 10 : 1) / fps();
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            event.stopPropagation();
            const direction = event.key === 'ArrowLeft' ? -1 : 1;
            const base = which === 'in' ? state.inPoint : state.outPoint;
            if (which === 'in') setInPoint(base + direction * step);
            else setOutPoint(base + direction * step);
        }
    }

    function updatePlayhead() {
        if (!state.duration) {
            els.playhead.style.left = '0%';
            return;
        }
        els.playhead.style.left = `${rangePercent(state.currentTime)}%`;
        updateRangeHint();
    }

    /* ------------------------------------------------------------------ */
    /* Prepare / insert                                                    */
    /* ------------------------------------------------------------------ */

    async function prepareClip() {
        if (!state.video || state.preparing) return;
        if (rangeDuration() < minGap()) {
            toast('The range is too short. Set a wider In and Out point.', 'error');
            return;
        }

        state.preparing = true;
        state.cancelRequested = false;
        state.jobId = `job-${Date.now()}`;
        state.progress = { percent: 0, label: 'Preparing…', detail: '' };
        els.progressPanel.classList.remove('hidden');
        els.progressFill.style.width = '0%';
        els.progressPercent.textContent = '0%';
        els.progressLabel.textContent = 'Preparing…';
        els.progressDetail.textContent = '';
        updateRangeUI();
        updatePrepareState();

        try {
            const result = unwrap(await api.prepareClip({
                jobId: state.jobId,
                video: state.video,
                url: state.video.url,
                start: state.inPoint,
                end: state.outPoint,
                projectFps: fps()
            }));
            state.preparedClip = { ...result.record, exists: true };
            upsertLibrary(state.preparedClip);
            setProgress(100, 'Ready to drag');
            toast('Clip prepared. Drag the card onto your timeline, or insert it at the playhead.', 'success', 7000);
            refreshCacheStats();
        } catch (error) {
            const message = cleanError(error);
            if (/canceled/i.test(message)) {
                toast('Download canceled.', 'info');
            } else {
                toast(message, 'error', 9000);
            }
            els.progressPanel.classList.add('hidden');
        } finally {
            state.preparing = false;
            state.jobId = null;
            updateRangeUI();
            updatePrepareState();
        }
    }

    async function cancelPrepare() {
        if (!state.preparing) return;
        state.cancelRequested = true;
        els.cancelBtn.disabled = true;
        els.cancelBtn.textContent = 'Canceling…';
        try {
            await api.cancelJob();
        } catch (error) {
            toast(cleanError(error), 'error');
        } finally {
            els.cancelBtn.disabled = false;
            els.cancelBtn.textContent = 'Cancel download';
        }
    }

    function onProgress(data) {
        if (!data || data.jobId !== state.jobId) return;
        const percent = clamp(Number(data.percent) || 0, 0, 100);
        state.progress = data;
        els.progressPanel.classList.remove('hidden');
        els.progressFill.style.width = `${percent}%`;
        els.progressPercent.textContent = `${Math.round(percent)}%`;
        els.progressLabel.textContent = data.message || 'Preparing…';
        const bits = [];
        if (data.speed) bits.push(data.speed);
        if (data.eta) bits.push(`ETA ${data.eta}`);
        els.progressDetail.textContent = bits.join(' · ');
        els.progressPanel.classList.toggle('hidden', false);
    }

    function setProgress(percent, label) {
        els.progressPanel.classList.remove('hidden');
        els.progressFill.style.width = `${percent}%`;
        els.progressPercent.textContent = `${percent}%`;
        els.progressLabel.textContent = label;
    }

    function upsertLibrary(record) {
        if (!record) return;
        state.library = [record, ...state.library.filter((item) => item.id !== record.id)];
        renderLibrary();
    }

    async function insertRecord(record) {
        if (!record) return;
        const button = els.insertBtn;
        const oldText = button.innerHTML;
        button.disabled = true;
        button.textContent = 'Inserting…';
        try {
            const result = unwrap(await api.insertClip(record, {
                mode: 'playhead',
                trackIndex: Number(state.settings.trackIndex) || 1
            }));
            if (result.fallback) {
                toast(`The host appended the clip at the end of ${result.timelineName || 'the timeline'}.`, 'info', 7000);
            } else {
                toast(`Inserted on V${result.trackIndex} in ${result.timelineName || 'the timeline'}.`, 'success');
            }
            refreshHostState(true);
        } catch (error) {
            toast(cleanError(error), 'error', 8000);
        } finally {
            button.disabled = false;
            button.innerHTML = oldText;
        }
    }

    async function addToBin(record) {
        if (!record) return;
        try {
            const result = unwrap(await api.importClip(record, { select: true }));
            toast(`Added to the “${result.bin}” bin and selected. Press Enter or double-click in the Media Pool to load it into the host's Source Viewer.`, 'success', 9000);
            refreshHostState(true);
        } catch (error) {
            toast(cleanError(error), 'error', 8000);
        }
    }

    async function removeRecord(record) {
        if (!record) return;
        const ok = window.confirm(`Remove “${record.title}” from Prepared clips and delete the cached file?`);
        if (!ok) return;
        try {
            await api.removeClip(record.id, true);
            if (state.preparedClip && state.preparedClip.id === record.id) state.preparedClip = null;
            state.library = state.library.filter((item) => item.id !== record.id);
            renderLibrary();
            refreshCacheStats();
            updateRangeUI();
            toast('Clip removed.', 'info');
        } catch (error) {
            toast(cleanError(error), 'error');
        }
    }

    function openSourcePage() {
        if (!state.video) return;
        api.openExternal(state.video.url).catch((error) => toast(cleanError(error), 'error'));
    }

    /* ------------------------------------------------------------------ */
    /* Library                                                             */
    /* ------------------------------------------------------------------ */

    function renderLibrary() {
        const grid = els.libraryGrid;
        grid.replaceChildren();

        if (!state.library.length) {
            const empty = document.createElement('div');
            empty.className = 'library-empty';
            empty.appendChild(makeIcon('i-film'));
            const copy = document.createElement('div');
            const title = document.createElement('p');
            title.textContent = 'Your prepared clips will appear here.';
            const detail = document.createElement('span');
            detail.textContent = 'Load a video, set a range, then press Prepare clip.';
            copy.append(title, detail);
            empty.appendChild(copy);
            grid.appendChild(empty);
            return;
        }

        const fragment = document.createDocumentFragment();
        state.library.forEach((record) => fragment.appendChild(createLibraryCard(record)));
        grid.appendChild(fragment);
    }

    function createLibraryCard(record) {
        const card = document.createElement('article');
        card.className = `lib-card${record.exists === false ? ' is-missing' : ''}`;
        card.dataset.id = record.id;
        card.draggable = record.exists !== false;

        const thumb = document.createElement('div');
        thumb.className = 'lib-thumb';
        if (record.thumbnail) {
            const img = document.createElement('img');
            img.src = record.thumbnail;
            img.alt = '';
            img.loading = 'lazy';
            thumb.appendChild(img);
        }
        const range = document.createElement('span');
        range.className = 'lib-range-badge';
        range.textContent = `${formatShortTime(record.start)}–${formatShortTime(record.end)}`;
        const dragBadge = document.createElement('span');
        dragBadge.className = 'lib-drag-badge';
        dragBadge.title = 'Drag to timeline';
        dragBadge.appendChild(makeIcon('i-drag'));
        thumb.append(range, dragBadge);

        const body = document.createElement('div');
        body.className = 'lib-body';
        const title = document.createElement('p');
        title.className = 'lib-title';
        title.title = record.title || '';
        title.textContent = record.title || record.videoId || 'Web clip';

        const meta = document.createElement('div');
        meta.className = 'lib-meta';
        const size = document.createElement('span');
        size.textContent = formatBytes(record.size);
        const dot1 = document.createElement('span');
        dot1.textContent = '·';
        const duration = document.createElement('span');
        duration.textContent = formatShortTime(record.duration);
        meta.append(size, dot1, duration);

        const actions = document.createElement('div');
        actions.className = 'lib-actions';
        actions.append(
            actionButton('reveal', 'i-folder', 'Reveal file'),
            actionButton('bin', 'i-plus', 'Add to Media Pool'),
            actionButton('remove', 'i-trash', 'Remove'),
            actionButton('insert', 'i-mark-in', 'Insert at playhead', 'lib-insert', 'Insert')
        );

        body.append(title, meta, actions);
        card.append(thumb, body);
        if (record.exists === false) {
            card.title = 'The cached file is missing. Prepare the range again.';
        }
        return card;
    }

    function actionButton(action, icon, title, className = '', text = '') {
        const button = document.createElement('button');
        button.className = `mini-btn ${className}`.trim();
        button.dataset.action = action;
        button.title = title;
        button.appendChild(makeIcon(icon));
        if (text) {
            const span = document.createElement('span');
            span.textContent = text;
            button.appendChild(span);
        }
        return button;
    }

    function onLibraryClick(event) {
        const button = event.target.closest('button[data-action]');
        if (!button) return;
        const card = button.closest('.lib-card');
        if (!card) return;
        const record = state.library.find((item) => item.id === card.dataset.id);
        if (!record) return;

        switch (button.dataset.action) {
            case 'insert': insertRecord(record); break;
            case 'bin': addToBin(record); break;
            case 'remove': removeRecord(record); break;
            case 'reveal':
                api.revealFile(record.filePath).catch((error) => toast(cleanError(error), 'error'));
                break;
            default: break;
        }
    }

    function onLibraryDragStart(event) {
        const card = event.target.closest('.lib-card');
        if (!card) return;
        const record = state.library.find((item) => item.id === card.dataset.id);
        if (!record || record.exists === false) {
            event.preventDefault();
            return;
        }
        event.preventDefault();
        state.draggingId = record.id;
        card.classList.add('drag-source');
        try {
            api.startDrag(record.filePath);
        } catch (error) {
            toast(cleanError(error), 'error');
        }
        setTimeout(() => card.classList.remove('drag-source'), 1500);
    }

    function onLibraryDragEnd() {
        if (state.draggingId) {
            const old = els.libraryGrid.querySelector(`[data-id="${state.draggingId}"]`);
            if (old) old.classList.remove('drag-source');
        }
        state.draggingId = null;
    }

    async function refreshCacheStats() {
        if (!hasHostApi) {
            els.cacheSize.textContent = '';
            return;
        }
        try {
            const stats = unwrap(await api.getCacheStats());
            els.cacheSize.textContent = `${stats.count} file${stats.count === 1 ? '' : 's'} · ${formatBytes(stats.bytes)}`;
            els.settingsCacheSize.textContent = formatBytes(stats.bytes);
            els.cachePath.textContent = stats.dir;
        } catch { /* optional */ }
    }

    async function openCacheFolder() {
        try {
            await api.openCacheFolder();
        } catch (error) {
            toast(cleanError(error), 'error');
        }
    }

    async function clearCache() {
        const ok = window.confirm('Delete every prepared clip file from the cache? This cannot be undone.');
        if (!ok) return;
        try {
            await api.clearCache();
            state.library = [];
            state.preparedClip = null;
            renderLibrary();
            refreshCacheStats();
            updateRangeUI();
            toast('Cache cleared.', 'success');
        } catch (error) {
            toast(cleanError(error), 'error');
        }
    }

    /* ------------------------------------------------------------------ */
    /* Host state                                                          */
    /* ------------------------------------------------------------------ */

    async function refreshHostState(silent = false, manual = false) {
        if (!hasHostApi) return;
        try {
            const next = unwrap(await api.getHostState());
            const changedFps = Number(state.hostState.fps) !== Number(next.fps);
            state.hostState = next;
            updateHostStatus();
            if (changedFps) {
                updateVideoCard();
                updateRangeUI();
            }
            if (manual) toast('Host state refreshed.', 'success', 2500);
        } catch (error) {
            state.hostState = { connected: false, error: cleanError(error) };
            updateHostStatus();
            if (!silent || manual) toast(cleanError(error), 'error', 6000);
        }
    }

    function updateHostStatus() {
        const info = state.hostState || {};
        const connected = Boolean(info.connected);
        const standalone = !connected && (
            !hasHostApi ||
            /communication with host|host bridge|initialize/i.test(String(info.error || ''))
        );

        els.hostPill.classList.toggle('connected', connected);
        els.hostPill.classList.toggle('error', !connected && !standalone && Boolean(info.error));
        els.hostPill.classList.toggle('standalone', standalone);
        els.hostPillText.textContent = connected
            ? 'Host connected'
            : standalone
                ? 'Standalone preview'
                : 'Host unavailable';

        if (connected) {
            const timeline = info.timelineName ? `Timeline: ${info.timelineName}` : 'No timeline open';
            els.projectInfo.textContent = `${info.projectName || 'Project'} · ${timeline}`;
            els.projectInfo.title = info.playheadTimecode ? `Playhead ${info.playheadTimecode}` : '';
        } else if (standalone) {
            els.projectInfo.textContent = 'Preview and clip preparation work here. Timeline actions need the paid host build.';
            els.projectInfo.title = info.error || '';
        } else {
            els.projectInfo.textContent = info.error || 'Open a project and timeline in the host editor.';
        }
        els.fpsInfo.textContent = connected ? projectFpsLabel() : '— fps';
        els.durationTc.textContent = formatTC(state.duration);
    }

    /* ------------------------------------------------------------------ */
    /* Settings                                                           */
    /* ------------------------------------------------------------------ */

    function openSettings() {
        state.modalOpen = true;
        els.settingsModal.classList.remove('hidden');
        els.maxHeightSelect.value = String(state.settings.maxHeight || 1080);
        els.binNameInput.value = state.settings.binName || 'Web Clips';
        els.trackSelect.value = String(state.settings.trackIndex || 1);
        els.cachePath.textContent = state.settings.cacheDir || '—';
        refreshCacheStats();
        updateToolsUI();
        updateSettingsHostInfo();
        els.closeSettingsBtn.focus();
    }

    function closeSettings() {
        state.modalOpen = false;
        els.settingsModal.classList.add('hidden');
    }

    async function saveSettings() {
        const next = {
            maxHeight: Number(els.maxHeightSelect.value),
            binName: els.binNameInput.value.trim() || 'Web Clips',
            trackIndex: Number(els.trackSelect.value),
            insertMode: 'playhead'
        };
        try {
            const saved = unwrap(await api.saveSettings(next));
            state.settings = saved;
            closeSettings();
            updateRangeUI();
            refreshCacheStats();
            toast('Settings saved.', 'success');
        } catch (error) {
            toast(cleanError(error), 'error');
        }
    }

    function updateToolsUI() {
        const tools = state.tools;
        if (!tools) {
            els.toolsState.textContent = 'Checking…';
            return;
        }
        const yt = tools.ytDlp || {};
        const ff = tools.ffmpeg || {};
        els.ytdlpVersion.textContent = yt.ok ? (yt.version || 'ready') : (yt.error || 'missing');
        els.ytdlpVersion.title = yt.path || '';
        els.ffmpegVersion.textContent = ff.ok ? (ff.version || 'ready') : (ff.error || 'missing');
        els.ffmpegVersion.title = ff.path || '';
        els.ffmpegState.textContent = ff.ok ? 'Ready' : 'Missing';
        els.ffmpegState.className = `badge ${ff.ok ? 'ok' : 'err'}`;
        els.toolsState.textContent = yt.ok && ff.ok ? 'Ready' : 'Needs attention';
        els.toolsState.className = `tiny ${yt.ok && ff.ok ? 'muted' : ''}`;
        els.updateYtDlpBtn.disabled = !yt.ok;
    }

    function updateSettingsHostInfo() {
        const info = state.hostState || {};
        const standalone = !info.connected && /communication with host|host bridge|initialize/i.test(String(info.error || ''));
        els.settingsHostState.textContent = info.connected ? 'Connected' : standalone ? 'Standalone' : 'Offline';
        els.settingsHostState.className = `badge ${info.connected ? 'ok' : standalone ? 'warn' : 'err'}`;
        els.settingsHostInfo.textContent = info.connected
            ? `${info.product || 'Host editor'} ${info.version || ''} · ${info.projectName || 'Project'} · ${projectFpsLabel()}`
            : standalone
                ? 'Standalone preview mode. Timeline, Media Pool and Source Viewer actions require the paid host build.'
                : (info.error || 'Open a project in the host editor.');
    }

    async function updateYtDlp() {
        const button = els.updateYtDlpBtn;
        button.disabled = true;
        button.querySelector('span').textContent = 'Updating…';
        try {
            const result = unwrap(await api.updateYtDlp());
            state.tools = result.tools;
            updateToolsUI();
            toast('yt-dlp updated.', 'success');
        } catch (error) {
            toast(cleanError(error), 'error', 8000);
        } finally {
            button.disabled = false;
            button.querySelector('span').textContent = 'Update';
        }
    }

    /* ------------------------------------------------------------------ */
    /* Keyboard                                                            */
    /* ------------------------------------------------------------------ */

    function onGlobalKeyDown(event) {
        if (state.modalOpen) {
            if (event.key === 'Escape') closeSettings();
            return;
        }
        const target = event.target;
        if (target && (target.matches('input, textarea, select') || target.isContentEditable)) return;
        if (event.ctrlKey || event.metaKey || event.altKey) {
            return;
        }

        const key = event.key;
        if (key === ' ' || key === 'Spacebar') {
            event.preventDefault();
            togglePlayback();
            return;
        }
        if (key === 'ArrowLeft' || key === 'ArrowRight') {
            event.preventDefault();
            stepFrames(key === 'ArrowLeft' ? -1 : 1, event.shiftKey ? Math.round(fps()) : 1);
            return;
        }
        if (key === 'Home') { event.preventDefault(); seekTo(0); return; }
        if (key === 'End') { event.preventDefault(); seekTo(state.duration); return; }
        if (key === 'i' || key === 'I') {
            event.preventDefault();
            if (event.shiftKey) seekTo(state.inPoint);
            else setInPoint(state.currentTime);
            return;
        }
        if (key === 'o' || key === 'O') {
            event.preventDefault();
            if (event.shiftKey) seekTo(state.outPoint);
            else setOutPoint(state.currentTime);
            return;
        }
        if (key === 'x' || key === 'X') {
            if (event.altKey) { event.preventDefault(); resetMarks(); }
            return;
        }
        if (key === 'k' || key === 'K') {
            event.preventDefault();
            if (state.playing) {
                playerCommand('pauseVideo');
                state.playing = false;
                updatePlayButton();
            }
            return;
        }
        if (key === 'l' || key === 'L') {
            event.preventDefault();
            if (!state.playing) togglePlayback();
            return;
        }
        if (key === 'j' || key === 'J') {
            event.preventDefault();
            seekTo(Math.max(0, state.currentTime - 5));
            return;
        }
    }

    /* ------------------------------------------------------------------ */
    /* Misc                                                               */
    /* ------------------------------------------------------------------ */

    function cleanError(error) {
        const text = error && error.message ? error.message : String(error || 'Unknown error');
        return text.replace(/^Error invoking remote method '[^']+':\s*Error:\s*/i, '').replace(/^Error:\s*/i, '');
    }

    function configureMockState() {
        if (hasHostApi) return;
        state.hostState = { connected: false, error: 'Preview mode - open inside the host editor to connect.' };
    }

    function createMockApi() {
        const mockStats = { dir: 'Preview', bytes: 0, count: 0 };
        const demoLibrary = state.demo ? [{
            id: 'demo-clip',
            videoId: DEMO_VIDEO.videoId,
            title: DEMO_VIDEO.title,
            channel: DEMO_VIDEO.channel,
            thumbnail: DEMO_VIDEO.thumbnail,
            url: DEMO_VIDEO.url,
            start: 64,
            end: 142,
            duration: 78,
            sourceDuration: DEMO_VIDEO.duration,
            fps: 60,
            projectFps: 24,
            width: 1920,
            height: 1080,
            maxHeight: 1080,
            filePath: 'C:\\Preview\\big-buck-bunny.mp4',
            size: 48 * 1024 * 1024,
            createdAt: Date.now(),
            exists: true
        }] : [];
        return {
            getBootData: async () => ({
                ok: true,
                data: {
                    settings: { maxHeight: 1080, binName: 'Web Clips', trackIndex: 1, cacheDir: 'Preview mode' },
                    library: demoLibrary,
                    tools: { ytDlp: { ok: false, error: 'Preview mode' }, ffmpeg: { ok: false, error: 'Preview mode' } },
                    hostState: { connected: false, error: 'Preview mode' },
                    version: 'preview'
                }
            }),
            loadVideo: async () => ({ ok: false, error: 'Open this panel inside the host editor to load web videos.' }),
            prepareClip: async () => ({ ok: false, error: 'Open this panel inside the host editor to prepare clips.' }),
            cancelJob: async () => ({ ok: true, data: { canceled: false } }),
            getLibrary: async () => ({ ok: true, data: [] }),
            removeClip: async () => ({ ok: true, data: { removed: true } }),
            importClip: async () => ({ ok: false, error: 'Preview mode' }),
            insertClip: async () => ({ ok: false, error: 'Preview mode' }),
            selectInMediaPool: async () => ({ ok: false, error: 'Preview mode' }),
            getHostState: async () => ({ ok: false, error: 'Preview mode' }),
            saveSettings: async (next) => ({ ok: true, data: next }),
            probeTools: async () => ({ ok: true, data: null }),
            updateYtDlp: async () => ({ ok: false, error: 'Preview mode' }),
            getCacheStats: async () => ({ ok: true, data: mockStats }),
            clearCache: async () => ({ ok: true, data: { cleared: true } }),
            revealFile: async () => ({ ok: false, error: 'Preview mode' }),
            openCacheFolder: async () => ({ ok: false, error: 'Preview mode' }),
            openExternal: async (url) => { window.open(url, '_blank', 'noopener'); return { ok: true, data: { opened: true } }; },
            startDrag: () => {},
            onProgress: () => () => {},
            onLog: () => () => {}
        };
    }
})();
