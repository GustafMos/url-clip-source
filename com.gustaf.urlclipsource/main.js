'use strict';

/*
 * URL Clip Source - a workflow integration for the host editor.
 *
 * The plugin uses the host application's JavaScript API (through the
 * WorkflowIntegration bridge) and two small command line tools:
 *   - yt-dlp.exe  : reads remote video metadata and downloads the selected section
 *   - ffmpeg.exe  : lets yt-dlp make an accurate, edit-ready MP4 cut
 *
 * Downloads are intentionally limited to the In/Out range instead of the full
 * video. That keeps the workflow quick even for long source videos.
 */

const { app, BrowserWindow, ipcMain, shell, nativeImage, session } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const WorkflowIntegration = require('./WorkflowIntegration.node');

const PLUGIN_ID = 'com.gustaf.urlclipsource';
const APP_DIR = __dirname;
const BIN_DIR = path.join(APP_DIR, 'bin');
const YTDLP = path.join(BIN_DIR, 'yt-dlp.exe');
const FFMPEG = path.join(BIN_DIR, 'ffmpeg.exe');

const DATA_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'URL Clip Source');
const DEFAULT_CACHE_DIR = path.join(DATA_DIR, 'clips');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const LIBRARY_FILE = path.join(DATA_DIR, 'library.json');
const LOG_FILE = path.join(DATA_DIR, 'app.log');

const DEFAULT_SETTINGS = {
    maxHeight: 1080,
    cacheDir: DEFAULT_CACHE_DIR,
    binName: 'Web Clips',
    trackIndex: 1,
    insertMode: 'playhead'
};

const ALLOWED_HEIGHTS = [720, 1080, 1440, 2160];

let mainWindow = null;
let hostPromise = null;
let initPromise = null;
let activeJob = null;
let settings = { ...DEFAULT_SETTINGS };
let library = [];
let toolsCache = null;
let toolsCacheTime = 0;
const metadataCache = new Map();

/* ----------------------------------------------------------------------- */
/* Small helpers                                                           */
/* ----------------------------------------------------------------------- */

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function readJson(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return fallback;
    }
}

async function writeJson(file, value) {
    ensureDir(path.dirname(file));
    const temp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(temp, JSON.stringify(value, null, 2), 'utf8');
    try {
        await fsp.rename(temp, file);
    } catch {
        await fsp.rm(file, { force: true });
        await fsp.rename(temp, file);
    }
}

function log(...parts) {
    const line = `[${new Date().toISOString()}] ${parts.map((p) => {
        if (typeof p === 'string') return p;
        try { return JSON.stringify(p); } catch { return String(p); }
    }).join(' ')}`;
    try {
        ensureDir(DATA_DIR);
        fs.appendFileSync(LOG_FILE, `${line}\n`);
    } catch { /* logging must never break the plugin */ }
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('app:log', line);
    }
}

function sendProgress(jobId, payload) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('job:progress', { jobId, ...payload });
}

function isInside(base, candidate) {
    const basePath = path.resolve(base);
    const target = path.resolve(candidate);
    const rel = path.relative(basePath, target);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function assertCachePath(candidate) {
    const cacheDir = getCacheDir();
    if (!isInside(cacheDir, candidate)) {
        throw new Error('That file is outside the clip cache.');
    }
    return candidate;
}

function getCacheDir() {
    const dir = settings.cacheDir || DEFAULT_CACHE_DIR;
    return path.isAbsolute(dir) ? dir : DEFAULT_CACHE_DIR;
}

function getSettingsSnapshot() {
    return {
        ...settings,
        cacheDir: getCacheDir(),
        dataDir: DATA_DIR,
        defaultCacheDir: DEFAULT_CACHE_DIR
    };
}

function normalizeSettings(input = {}) {
    const next = { ...settings };
    if (ALLOWED_HEIGHTS.includes(Number(input.maxHeight))) next.maxHeight = Number(input.maxHeight);
    if (typeof input.binName === 'string' && input.binName.trim()) next.binName = input.binName.trim().slice(0, 48);
    const track = Number(input.trackIndex);
    if (Number.isInteger(track) && track >= 1 && track <= 8) next.trackIndex = track;
    if (input.insertMode === 'playhead' || input.insertMode === 'append') next.insertMode = input.insertMode;
    if (typeof input.cacheDir === 'string' && input.cacheDir.trim()) {
        const dir = path.resolve(input.cacheDir.trim());
        if (dir.length > 3) next.cacheDir = dir;
    }
    return next;
}

function formatClock(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0
        ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
        : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatSectionTime(seconds) {
    return Math.max(0, Number(seconds) || 0).toFixed(3);
}

function parseNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

async function envelope(fn) {
    try {
        return { ok: true, data: await fn() };
    } catch (error) {
        const message = error && error.message ? error.message : String(error);
        log('ERROR:', message);
        return { ok: false, error: message };
    }
}

/* ----------------------------------------------------------------------- */
/* Persistence                                                             */
/* ----------------------------------------------------------------------- */

async function loadPersistentState() {
    ensureDir(DATA_DIR);
    ensureDir(DEFAULT_CACHE_DIR);
    ensureDir(TMP_DIR);

    const saved = readJson(SETTINGS_FILE, {});
    settings = normalizeSettings({ ...DEFAULT_SETTINGS, ...saved });

    const savedLibrary = readJson(LIBRARY_FILE, []);
    library = Array.isArray(savedLibrary) ? savedLibrary.filter((item) => item && item.id && item.filePath) : [];

    // Drop cache locations that vanished, but keep the record so the user can
    // see what was there and remove it deliberately.
    library = library.map((item) => ({ ...item, exists: fs.existsSync(item.filePath) }));

    ensureDir(getCacheDir());
    await cleanupTmp();
    await writeJson(SETTINGS_FILE, settings);
    await writeJson(LIBRARY_FILE, library);
}

async function cleanupTmp() {
    try {
        ensureDir(TMP_DIR);
        const entries = await fsp.readdir(TMP_DIR, { withFileTypes: true });
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        for (const entry of entries) {
            if (!entry.isFile()) continue;
            const fullPath = path.join(TMP_DIR, entry.name);
            try {
                const stat = await fsp.stat(fullPath);
                if (stat.mtimeMs < cutoff) await fsp.rm(fullPath, { force: true });
            } catch { /* ignore */ }
        }
    } catch { /* cleanup is best effort */ }
}

async function saveLibrary() {
    await writeJson(LIBRARY_FILE, library);
}

function getLibrarySnapshot() {
    return library
        .map((item) => ({
            ...item,
            exists: fs.existsSync(item.filePath),
            size: (() => {
                try { return fs.statSync(item.filePath).size; } catch { return 0; }
            })()
        }))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/* ----------------------------------------------------------------------- */
/* Host interface                                                          */
/* ----------------------------------------------------------------------- */

async function getHost() {
    if (hostPromise) return hostPromise;
    if (!initPromise) {
        initPromise = (async () => {
            const initialized = await WorkflowIntegration.InitializePromise(PLUGIN_ID);
            if (!initialized) throw new Error('Could not initialize the host scripting interface.');
            const resolve = await WorkflowIntegration.GetResolvePromise();
            if (!resolve) throw new Error('Could not get the host application object.');
            hostPromise = resolve;
            return resolve;
        })().catch((error) => {
            initPromise = null;
            throw error;
        });
    }
    return initPromise;
}

async function getProjectContext() {
    const resolve = await getHost();
    const projectManager = await resolve.GetProjectManager();
    if (!projectManager) throw new Error('Could not access the Project Manager.');
    const project = await projectManager.GetCurrentProject();
    if (!project) throw new Error('Open a project in the host editor first.');
    return { resolve, projectManager, project };
}

function parseTimelineFps(settingValue) {
    const parsed = parseFloat(String(settingValue || '').replace(',', '.'));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 24;
}

function timecodeToFrames(timecode, fps) {
    if (!timecode) return null;
    const match = String(timecode).trim().match(/^(\d{1,3}):(\d{2}):(\d{2})([:;])(\d{2,3})$/);
    if (!match) return null;
    const [, hh, mm, ss, separator, ff] = match;
    const nominal = Math.max(1, Math.round(fps));
    const hours = Number(hh);
    const minutes = Number(mm);
    const seconds = Number(ss);
    const frames = Number(ff);
    let total = ((hours * 60 + minutes) * 60 + seconds) * nominal + frames;
    if (separator === ';') {
        const dropPerMinute = Math.round(nominal / 15);
        const totalMinutes = hours * 60 + minutes;
        total -= dropPerMinute * (totalMinutes - Math.floor(totalMinutes / 10));
    }
    return total;
}

async function getHostStateInternal() {
    const { resolve, project } = await getProjectContext();
    const fps = parseTimelineFps(await project.GetSetting('timelineFrameRate'));
    const projectName = await project.GetName();
    const timeline = await project.GetCurrentTimeline();

    const state = {
        connected: true,
        product: await resolve.GetProductName().catch(() => 'Host editor'),
        version: await resolve.GetVersionString().catch(() => ''),
        projectName,
        timelineName: null,
        fps,
        width: parseNumber(await project.GetSetting('timelineResolutionWidth'), 1920),
        height: parseNumber(await project.GetSetting('timelineResolutionHeight'), 1080),
        playheadTimecode: null,
        playheadFrame: null,
        startTimecode: null,
        startFrame: null
    };

    if (timeline) {
        state.timelineName = await timeline.GetName().catch(() => null);
        state.startFrame = await timeline.GetStartFrame().catch(() => null);
        state.startTimecode = await timeline.GetStartTimecode().catch(() => null);
        state.playheadTimecode = await timeline.GetCurrentTimecode().catch(() => null);
        if (state.startFrame != null && state.startTimecode && state.playheadTimecode) {
            const start = timecodeToFrames(state.startTimecode, fps);
            const playhead = timecodeToFrames(state.playheadTimecode, fps);
            if (start != null && playhead != null) {
                state.playheadFrame = state.startFrame + (playhead - start);
            }
        }
    }

    return state;
}

async function ensureBin(mediaPool, rootFolder, binName) {
    const folders = await rootFolder.GetSubFolderList();
    for (const folder of folders || []) {
        const name = await folder.GetName();
        if (name === binName) return folder;
    }
    const created = await mediaPool.AddSubFolder(rootFolder, binName);
    return created || rootFolder;
}

async function findClipByPath(folder, filePath) {
    const target = path.resolve(filePath).toLowerCase();
    const clips = await folder.GetClipList();
    for (const clip of clips || []) {
        try {
            const clipPath = await clip.GetClipProperty('File Path');
            if (clipPath && path.resolve(clipPath).toLowerCase() === target) return clip;
        } catch { /* keep looking */ }
    }
    const subFolders = await folder.GetSubFolderList();
    for (const subFolder of subFolders || []) {
        const found = await findClipByPath(subFolder, filePath);
        if (found) return found;
    }
    return null;
}

async function ensureMediaPoolItem(record) {
    if (!record || !record.filePath) throw new Error('The clip record is incomplete.');
    if (!fs.existsSync(record.filePath)) throw new Error('The prepared clip file is missing. Prepare it again.');

    const { project } = await getProjectContext();
    const mediaPool = await project.GetMediaPool();
    if (!mediaPool) throw new Error('Could not access the Media Pool.');
    const rootFolder = await mediaPool.GetRootFolder();
    if (!rootFolder) throw new Error('Could not access the Media Pool root folder.');

    const binName = settings.binName || 'Web Clips';
    const bin = await ensureBin(mediaPool, rootFolder, binName);
    const previousFolder = await mediaPool.GetCurrentFolder().catch(() => null);

    let item = await findClipByPath(bin, record.filePath);
    if (!item) {
        try {
            await mediaPool.SetCurrentFolder(bin);
            const imported = await mediaPool.ImportMedia([record.filePath]);
            if (!imported || imported.length === 0) {
                throw new Error('The host editor did not import the prepared clip.');
            }
            item = imported[0];

            const rangeLabel = `${formatClock(record.start)}-${formatClock(record.end)}`;
            const clipName = `${record.title || record.videoId || 'Web clip'} [${rangeLabel}]`;
            await item.SetName(clipName).catch(() => false);
            await item.SetMetadata('Comments', `Source URL\n${record.url || ''}\nIn ${Number(record.start || 0).toFixed(3)}s  Out ${Number(record.end || 0).toFixed(3)}s`).catch(() => false);
            await item.SetClipColor('Red').catch(() => false);
        } finally {
            if (previousFolder) await mediaPool.SetCurrentFolder(previousFolder).catch(() => false);
        }
    } else if (previousFolder) {
        await mediaPool.SetCurrentFolder(previousFolder).catch(() => false);
    }

    return { item, bin, mediaPool };
}

/* ----------------------------------------------------------------------- */
/* Tools                                                                   */
/* ----------------------------------------------------------------------- */

function runCapture(exe, args, options = {}) {
    return new Promise((resolve, reject) => {
        const timeout = options.timeout || 20000;
        let stdout = '';
        let stderr = '';
        let settled = false;
        let timer = null;

        let child;
        try {
            child = spawn(exe, args, {
                windowsHide: true,
                cwd: APP_DIR,
                env: { ...process.env }
            });
        } catch (error) {
            reject(error);
            return;
        }

        timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { child.kill(); } catch { /* ignore */ }
            reject(new Error(`${path.basename(exe)} timed out.`));
        }, timeout);

        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
            if (stdout.length > 80 * 1024 * 1024) stdout = stdout.slice(-1024 * 1024);
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
            if (stderr.length > 4 * 1024 * 1024) stderr = stderr.slice(-512 * 1024);
        });
        child.on('error', (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        });
        child.on('close', (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
        });
    });
}

async function probeTools(force = false) {
    if (!force && toolsCache && Date.now() - toolsCacheTime < 30000) return toolsCache;

    const result = {
        ytDlp: { path: YTDLP, ok: fs.existsSync(YTDLP), version: '', error: '' },
        ffmpeg: { path: FFMPEG, ok: fs.existsSync(FFMPEG), version: '', error: '' }
    };

    if (result.ytDlp.ok) {
        try {
            const run = await runCapture(YTDLP, ['--version'], { timeout: 15000 });
            result.ytDlp.version = (run.stdout || run.stderr).trim().split(/\r?\n/)[0] || 'unknown';
            result.ytDlp.ok = run.code === 0;
            if (!result.ytDlp.ok) result.ytDlp.error = (run.stderr || run.stdout).trim().slice(-500);
        } catch (error) {
            result.ytDlp.ok = false;
            result.ytDlp.error = error.message;
        }
    } else {
        result.ytDlp.error = 'The downloader is missing from the plugin bin folder.';
    }

    if (result.ffmpeg.ok) {
        try {
            const run = await runCapture(FFMPEG, ['-version'], { timeout: 15000 });
            result.ffmpeg.version = (run.stdout || run.stderr).trim().split(/\r?\n/)[0] || 'unknown';
            result.ffmpeg.ok = run.code === 0;
            if (!result.ffmpeg.ok) result.ffmpeg.error = (run.stderr || run.stdout).trim().slice(-500);
        } catch (error) {
            result.ffmpeg.ok = false;
            result.ffmpeg.error = error.message;
        }
    } else {
        result.ffmpeg.error = 'The media helper is missing from the plugin bin folder.';
    }

    toolsCache = result;
    toolsCacheTime = Date.now();
    return result;
}

/* ----------------------------------------------------------------------- */
/* Source URLs and metadata                                                */
/* ----------------------------------------------------------------------- */

function extractVideoId(input) {
    const raw = String(input || '').trim();
    if (!raw) return null;
    if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return raw;

    let url;
    try {
        url = new URL(raw);
    } catch {
        return null;
    }

    const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
    const allowed = host === 'youtube.com' || host === 'youtu.be' || host === 'youtube-nocookie.com' || host === 'music.youtube.com';
    if (!allowed) return null;

    if (host === 'youtu.be') {
        const id = url.pathname.split('/').filter(Boolean)[0];
        return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : null;
    }

    if (url.pathname === '/watch') {
        const id = url.searchParams.get('v');
        return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : null;
    }

    const match = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})/);
    return match ? match[1] : null;
}

function normalizeVideoUrl(input) {
    const id = extractVideoId(input);
    if (!id) {
        throw new Error('Paste a video page link or an 11-character video ID.');
    }
    return { id, url: `https://www.youtube.com/watch?v=${id}` };
}

async function loadVideoInternal(input) {
    const { id, url } = normalizeVideoUrl(input);
    const cacheKey = id;
    const cached = metadataCache.get(cacheKey);
    if (cached && Date.now() - cached.time < 10 * 60 * 1000) return cached.value;

    const tools = await probeTools();
    if (!tools.ytDlp.ok) throw new Error(tools.ytDlp.error || 'yt-dlp is not available.');

    const args = [
        '--no-playlist',
        '--skip-download',
        '--dump-single-json',
        '--no-warnings',
        '--socket-timeout', '20',
        '--retries', '3',
        url
    ];

    const run = await runCapture(YTDLP, args, { timeout: 120000 });
    if (run.code !== 0) {
        const detail = (run.stderr || run.stdout).trim().split(/\r?\n/).filter(Boolean).slice(-4).join(' ');
        throw new Error(detail || 'Could not read that video page.');
    }

    const jsonLine = run.stdout.trim().split(/\r?\n/).filter((line) => line.trim().startsWith('{')).pop();
    if (!jsonLine) throw new Error('The source site returned no video information.');

    let info;
    try {
        info = JSON.parse(jsonLine);
    } catch {
        throw new Error('The source site returned an unreadable video description.');
    }

    if (info.is_live) throw new Error('Live streams are not supported. Wait until the stream is archived.');
    const duration = parseNumber(info.duration, 0);
    if (!(duration > 0)) throw new Error('This video has no usable duration.');

    const video = {
        videoId: id,
        url: info.webpage_url || url,
        title: info.title || 'Untitled web video',
        channel: info.channel || info.uploader || '',
        duration,
        fps: parseNumber(info.fps, 30) || 30,
        width: parseNumber(info.width, 1920) || 1920,
        height: parseNumber(info.height, 1080) || 1080,
        thumbnail: info.thumbnail || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        uploadDate: info.upload_date || '',
        description: String(info.description || '').slice(0, 4000)
    };

    metadataCache.set(cacheKey, { time: Date.now(), value: video });
    return video;
}

/* ----------------------------------------------------------------------- */
/* Download / prepare                                                      */
/* ----------------------------------------------------------------------- */

function buildDownloadArgs(video, start, end, maxHeight, outputPath) {
    const height = ALLOWED_HEIGHTS.includes(Number(maxHeight)) ? Number(maxHeight) : 1080;
    const format = [
        `bv*[height<=${height}][ext=mp4]+ba[ext=m4a]`,
        `bv*[height<=${height}]+ba`,
        `b[height<=${height}]`,
        'b'
    ].join('/');

    return [
        '--no-playlist',
        '--no-warnings',
        '--newline',
        '--no-colors',
        '--socket-timeout', '20',
        '--retries', '5',
        '--fragment-retries', '5',
        '--concurrent-fragments', '4',
        '--no-part',
        '--ffmpeg-location', FFMPEG,
        '--download-sections', `*${formatSectionTime(start)}-${formatSectionTime(end)}`,
        '--force-keyframes-at-cuts',
        '-f', format,
        '--merge-output-format', 'mp4',
        '-o', outputPath,
        video.url || `https://www.youtube.com/watch?v=${video.videoId}`
    ];
}

function killProcessTree(child) {
    if (!child || child.killed) return;
    try {
        if (process.platform === 'win32' && child.pid) {
            spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        } else {
            child.kill('SIGTERM');
        }
    } catch {
        try { child.kill(); } catch { /* ignore */ }
    }
}

async function downloadClip({ video, start, end, jobId }) {
    const maxHeight = settings.maxHeight;
    const id = crypto
        .createHash('sha1')
        .update(`${video.videoId}|${start.toFixed(3)}|${end.toFixed(3)}|${maxHeight}`)
        .digest('hex')
        .slice(0, 12);

    const cacheDir = ensureDir(getCacheDir());
    const fileName = `${video.videoId}_${Math.round(start * 1000)}-${Math.round(end * 1000)}_${maxHeight}p_${id}.mp4`;
    const finalPath = path.join(cacheDir, fileName);

    if (fs.existsSync(finalPath) && fs.statSync(finalPath).size > 1024) {
        return { id, filePath: finalPath, size: fs.statSync(finalPath).size, reused: true };
    }

    ensureDir(TMP_DIR);
    const tempPath = path.join(TMP_DIR, `${id}_${Date.now()}.mp4`);

    if (activeJob) throw new Error('A download is already running. Wait for it to finish or cancel it.');
    const args = buildDownloadArgs(video, start, end, maxHeight, tempPath);
    log('Starting yt-dlp:', args.join(' '));

    const child = spawn(YTDLP, args, {
        windowsHide: true,
        cwd: APP_DIR,
        env: { ...process.env }
    });
    activeJob = { jobId, child, canceled: false, tempPath };
    sendProgress(jobId, { phase: 'starting', percent: 0, message: 'Connecting to the source site.' });

    const lastLines = [];
    let progressPercent = 0;

    const consumeLine = (line) => {
        const clean = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
        if (!clean) return;
        lastLines.push(clean);
        if (lastLines.length > 30) lastLines.shift();

        const percentMatch = clean.match(/\[download\]\s+([\d.]+)%/);
        if (percentMatch) {
            progressPercent = Math.min(94, Number(percentMatch[1]) * 0.92);
            const speed = (clean.match(/\bat\s+([^\s]+\/s)/) || [])[1] || '';
            const eta = (clean.match(/ETA\s+([0-9:]+)/) || [])[1] || '';
            sendProgress(jobId, {
                phase: 'download',
                percent: progressPercent,
                message: `Downloading ${percentMatch[1]}%`,
                speed,
                eta
            });
            return;
        }
        if (/\[Merger\]|\[Fixup|\[VideoConvertor\]|\[Metadata\]/i.test(clean)) {
            sendProgress(jobId, { phase: 'finalize', percent: 95, message: 'Finalizing edit-ready MP4…' });
        }
    };

    let stdoutBuffer = '';
    let stderrBuffer = '';
    child.stdout.on('data', (chunk) => {
        stdoutBuffer += chunk.toString();
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() || '';
        lines.forEach(consumeLine);
    });
    child.stderr.on('data', (chunk) => {
        stderrBuffer += chunk.toString();
        const lines = stderrBuffer.split(/\r?\n/);
        stderrBuffer = lines.pop() || '';
        lines.forEach(consumeLine);
    });

    const exitCode = await new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code) => resolve(code));
    }).catch((error) => {
        activeJob = null;
        throw error;
    });

    if (stdoutBuffer) consumeLine(stdoutBuffer);
    if (stderrBuffer) consumeLine(stderrBuffer);

    const wasCanceled = activeJob && activeJob.canceled;
    activeJob = null;

    if (wasCanceled) {
        await fsp.rm(tempPath, { force: true }).catch(() => {});
        throw new Error('Download canceled.');
    }
    if (exitCode !== 0) {
        await fsp.rm(tempPath, { force: true }).catch(() => {});
        const detail = lastLines.slice(-4).join(' ') || `yt-dlp exited with code ${exitCode}.`;
        throw new Error(detail);
    }

    let produced = tempPath;
    if (!fs.existsSync(produced)) {
        // yt-dlp may append a container extension in some configurations.
        const candidates = await fsp.readdir(TMP_DIR);
        const match = candidates
            .filter((name) => name.startsWith(path.basename(tempPath, '.mp4')))
            .map((name) => path.join(TMP_DIR, name))
            .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
        if (match[0]) produced = match[0];
    }

    if (!fs.existsSync(produced) || fs.statSync(produced).size < 1024) {
        await fsp.rm(tempPath, { force: true }).catch(() => {});
        throw new Error('The download finished but no usable video file was produced.');
    }

    await fsp.rm(finalPath, { force: true }).catch(() => {});
    await fsp.rename(produced, finalPath);
    const size = fs.statSync(finalPath).size;
    sendProgress(jobId, { phase: 'done', percent: 100, message: 'Ready to drag' });
    return { id, filePath: finalPath, size, reused: false };
}

async function prepareClipInternal(payload = {}) {
    const { jobId } = payload;
    const video = payload.video && payload.video.videoId ? payload.video : await loadVideoInternal(payload.url);
    const duration = parseNumber(video.duration, 0);
    let start = parseNumber(payload.start, 0);
    let end = parseNumber(payload.end, duration);
    start = Math.max(0, Math.min(start, duration));
    end = Math.max(0, Math.min(end, duration));
    if (end - start < 0.08) throw new Error('Set an In and Out point at least a few frames apart.');
    if (!video.videoId) throw new Error('The video information is incomplete.');

    const result = await downloadClip({ video, start, end, jobId });

    const now = Date.now();
    const scaledHeight = Math.min(video.height || settings.maxHeight, settings.maxHeight);
    const scaledWidth = video.height
        ? Math.round((video.width || 0) * (scaledHeight / video.height))
        : video.width;
    let record = library.find((item) => item.id === result.id);
    if (record) {
        record = {
            ...record,
            title: video.title,
            channel: video.channel,
            thumbnail: video.thumbnail,
            url: video.url,
            duration: end - start,
            sourceDuration: duration,
            fps: video.fps,
            projectFps: parseNumber(payload.projectFps, 0) || null,
            width: scaledWidth,
            height: scaledHeight,
            maxHeight: settings.maxHeight,
            filePath: result.filePath,
            size: result.size,
            createdAt: record.createdAt || now
        };
    } else {
        record = {
            id: result.id,
            videoId: video.videoId,
            title: video.title,
            channel: video.channel,
            thumbnail: video.thumbnail,
            url: video.url,
            start,
            end,
            duration: end - start,
            sourceDuration: duration,
            fps: video.fps,
            projectFps: parseNumber(payload.projectFps, 0) || null,
            width: scaledWidth,
            height: scaledHeight,
            maxHeight: settings.maxHeight,
            filePath: result.filePath,
            size: result.size,
            createdAt: now
        };
    }

    library = [record, ...library.filter((item) => item.id !== record.id)];
    await saveLibrary();
    return { record, reused: result.reused };
}

/* ----------------------------------------------------------------------- */
/* Host actions                                                            */
/* ----------------------------------------------------------------------- */

async function insertClipInternal(record, options = {}) {
    const { item, mediaPool } = await ensureMediaPoolItem(record);
    const { resolve, project } = await getProjectContext();
    const mode = options.mode === 'append' ? 'append' : 'playhead';

    const timeline = await project.GetCurrentTimeline();
    if (!timeline) {
        throw new Error('Open or create a timeline on the Edit page first.');
    }

    await resolve.OpenPage('edit').catch(() => false);

    let state = null;
    try { state = await getHostStateInternal(); } catch { /* optional */ }

    const clipInfo = { mediaPoolItem: item };
    const trackIndex = Number(options.trackIndex || settings.trackIndex || 1);
    if (Number.isInteger(trackIndex) && trackIndex > 0) clipInfo.trackIndex = trackIndex;

    if (mode === 'playhead') {
        if (state && state.playheadFrame != null) {
            clipInfo.recordFrame = state.playheadFrame;
        }
        // No source start/end is supplied: the prepared file is already the
        // exact In/Out range, so the host should insert the whole clip.
    }

    const appended = await mediaPool.AppendToTimeline([clipInfo]);
    if (!appended || !appended.length) {
        const fallback = await mediaPool.AppendToTimeline([item]);
        if (!fallback || !fallback.length) {
            throw new Error('The host editor could not place the clip on the timeline.');
        }
        return {
            mode: 'append',
            timelineName: await timeline.GetName().catch(() => ''),
            trackIndex,
            recordFrame: null,
            fallback: true
        };
    }

    await mediaPool.SetSelectedClip(item).catch(() => false);
    return {
        mode,
        timelineName: await timeline.GetName().catch(() => ''),
        trackIndex,
        recordFrame: clipInfo.recordFrame ?? null,
        fallback: false
    };
}

async function importClipInternal(record, options = {}) {
    const { item, bin } = await ensureMediaPoolItem(record);
    const { project, resolve } = await getProjectContext();
    const mediaPool = await project.GetMediaPool();
    if (!mediaPool) throw new Error('Could not access the Media Pool.');
    if (options.select !== false) {
        await mediaPool.SetCurrentFolder(bin).catch(() => false);
        await mediaPool.SetSelectedClip(item).catch(() => false);
        await resolve.OpenPage('edit').catch(() => false);
    }
    return {
        name: await item.GetName().catch(() => ''),
        bin: await bin.GetName().catch(() => settings.binName),
        id: await item.GetUniqueId().catch(() => ''),
        selected: options.select !== false
    };
}

async function selectInMediaPoolInternal(record) {
    const { item, bin } = await ensureMediaPoolItem(record);
    const { project, resolve } = await getProjectContext();
    const mediaPool = await project.GetMediaPool();
    if (!mediaPool) throw new Error('Could not access the Media Pool.');
    await mediaPool.SetCurrentFolder(bin).catch(() => false);
    const selected = await mediaPool.SetSelectedClip(item).catch(() => false);
    await resolve.OpenPage('edit').catch(() => false);
    return {
        selected: Boolean(selected),
        name: await item.GetName().catch(() => ''),
        bin: await bin.GetName().catch(() => settings.binName)
    };
}

/* ----------------------------------------------------------------------- */
/* Cache actions                                                           */
/* ----------------------------------------------------------------------- */

async function getCacheStatsInternal() {
    const dir = ensureDir(getCacheDir());
    let bytes = 0;
    let count = 0;
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        try {
            const stat = await fsp.stat(path.join(dir, entry.name));
            bytes += stat.size;
            count += 1;
        } catch { /* ignore */ }
    }
    return { dir, bytes, count };
}

async function clearCacheInternal() {
    const dir = ensureDir(getCacheDir());
    if (path.resolve(dir) === path.resolve(DEFAULT_CACHE_DIR) || isInside(DATA_DIR, dir)) {
        const entries = await fsp.readdir(dir).catch(() => []);
        for (const name of entries) {
            await fsp.rm(path.join(dir, name), { force: true, recursive: true }).catch(() => {});
        }
    }
    library = [];
    await saveLibrary();
    return { cleared: true };
}

async function removeClipInternal(id, deleteFile) {
    const record = library.find((item) => item.id === id);
    if (!record) return { removed: false };
    library = library.filter((item) => item.id !== id);
    await saveLibrary();
    if (deleteFile && isInside(getCacheDir(), record.filePath)) {
        await fsp.rm(record.filePath, { force: true }).catch(() => {});
    }
    return { removed: true };
}

/* ----------------------------------------------------------------------- */
/* IPC                                                                     */
/* ----------------------------------------------------------------------- */

function registerIpc() {
    ipcMain.handle('api:getBootData', () => envelope(async () => {
        const tools = await probeTools();
        let hostState = null;
        try {
            hostState = await getHostStateInternal();
        } catch (error) {
            hostState = { connected: false, error: error.message };
        }
        return {
            settings: getSettingsSnapshot(),
            library: getLibrarySnapshot(),
            tools,
            hostState,
            platform: process.platform,
            version: app.getVersion ? app.getVersion() : '1.0.0'
        };
    }));

    ipcMain.handle('api:loadVideo', (_event, url) => envelope(() => loadVideoInternal(url)));

    ipcMain.handle('api:prepareClip', (event, payload = {}) => envelope(async () => {
        if (!payload.jobId) payload.jobId = `job-${Date.now()}`;
        const result = await prepareClipInternal(payload);
        return { ...result, jobId: payload.jobId };
    }));

    ipcMain.handle('api:cancelJob', () => envelope(async () => {
        if (!activeJob) return { canceled: false };
        activeJob.canceled = true;
        sendProgress(activeJob.jobId, { phase: 'canceling', percent: 0, message: 'Canceling…' });
        killProcessTree(activeJob.child);
        return { canceled: true };
    }));

    ipcMain.handle('api:getLibrary', () => envelope(async () => getLibrarySnapshot()));

    ipcMain.handle('api:removeClip', (_event, id, deleteFile = false) => envelope(() => removeClipInternal(id, deleteFile)));

    ipcMain.handle('api:importClip', (_event, record, options = {}) => envelope(() => importClipInternal(record, { select: options.select !== false })));

    ipcMain.handle('api:insertClip', (_event, record, options = {}) => envelope(() => insertClipInternal(record, options)));

    ipcMain.handle('api:selectInMediaPool', (_event, record) => envelope(() => selectInMediaPoolInternal(record)));

    ipcMain.handle('api:getHostState', () => envelope(() => getHostStateInternal()));

    ipcMain.handle('api:saveSettings', (_event, next) => envelope(async () => {
        const cleaned = normalizeSettings(next || {});
        ensureDir(cleaned.cacheDir);
        settings = cleaned;
        await writeJson(SETTINGS_FILE, settings);
        return getSettingsSnapshot();
    }));

    ipcMain.handle('api:probeTools', () => envelope(() => probeTools(true)));

    ipcMain.handle('api:updateYtDlp', () => envelope(async () => {
        if (!fs.existsSync(YTDLP)) throw new Error('The downloader is missing.');
        const run = await runCapture(YTDLP, ['-U'], { timeout: 180000 });
        const output = `${run.stdout || ''}\n${run.stderr || ''}`.trim();
        if (run.code !== 0) throw new Error(output.slice(-1000) || 'Downloader update failed.');
        toolsCache = null;
        const tools = await probeTools(true);
        return { output: output.slice(-2000), tools };
    }));

    ipcMain.handle('api:getCacheStats', () => envelope(() => getCacheStatsInternal()));
    ipcMain.handle('api:clearCache', () => envelope(() => clearCacheInternal()));

    ipcMain.handle('api:revealFile', (_event, filePath) => envelope(async () => {
        assertCachePath(filePath);
        if (!fs.existsSync(filePath)) throw new Error('That file no longer exists.');
        shell.showItemInFolder(filePath);
        return { revealed: true };
    }));

    ipcMain.handle('api:openCacheFolder', () => envelope(async () => {
        const dir = ensureDir(getCacheDir());
        const error = await shell.openPath(dir);
        if (error) throw new Error(error);
        return { opened: true };
    }));

    ipcMain.handle('api:openExternal', (_event, url) => envelope(async () => {
        let parsed;
        try { parsed = new URL(url); } catch { throw new Error('Invalid link.'); }
        if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Only web links can be opened.');
        await shell.openExternal(parsed.toString());
        return { opened: true };
    }));

    ipcMain.on('drag:start', (event, filePath) => {
        try {
            assertCachePath(filePath);
            if (!fs.existsSync(filePath)) return;
            const iconPath = path.join(APP_DIR, 'img', 'drag-icon.png');
            let icon = nativeImage.createFromPath(iconPath);
            if (icon.isEmpty()) {
                icon = nativeImage.createFromPath(path.join(APP_DIR, 'img', 'icon.png'));
            }
            event.sender.startDrag({ file: filePath, icon });
        } catch (error) {
            log('Drag failed:', error.message);
        }
    });
}

/* ----------------------------------------------------------------------- */
/* Window and app lifecycle                                                */
/* ----------------------------------------------------------------------- */

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1120,
        height: 820,
        minWidth: 880,
        minHeight: 640,
        useContentSize: true,
        backgroundColor: '#0f1115',
        autoHideMenuBar: true,
        title: 'URL Clip Source',
        webPreferences: {
            preload: path.join(APP_DIR, 'preload.js'),
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: true
        }
    });

    mainWindow.setMenuBarVisibility(false);
    mainWindow.loadFile(path.join(APP_DIR, 'index.html'));

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        try {
            const parsed = new URL(url);
            if (['https:', 'http:'].includes(parsed.protocol)) shell.openExternal(url);
        } catch { /* ignore */ }
        return { action: 'deny' };
    });

    mainWindow.webContents.on('will-navigate', (event, url) => {
        if (!url.startsWith('file://')) {
            event.preventDefault();
            try { shell.openExternal(url); } catch { /* ignore */ }
        }
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    mainWindow.on('close', () => {
        app.quit();
    });
}

async function bootstrap() {
    try {
        await loadPersistentState();
    } catch (error) {
        log('State load failed:', error.message);
        settings = { ...DEFAULT_SETTINGS };
        library = [];
        ensureDir(DEFAULT_CACHE_DIR);
    }

    registerIpc();

    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
        callback(false);
    });

    createWindow();
}

app.whenReady().then(bootstrap);

app.on('window-all-closed', () => {
    app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
    if (activeJob) killProcessTree(activeJob.child);
    try { WorkflowIntegration.CleanUp(); } catch { /* ignore */ }
});
