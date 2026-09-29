const elements = {
  appVersion: document.querySelector('#app-version'),
  url: document.querySelector('#url'),
  paste: document.querySelector('#paste'),
  douyinLogin: document.querySelector('#douyin-login'),
  tiktokLogin: document.querySelector('#tiktok-login'),
  bilibiliLogin: document.querySelector('#bilibili-login'),
  xiaohongshuLogin: document.querySelector('#xiaohongshu-login'),
  instagramLogin: document.querySelector('#instagram-login'),
  analyze: document.querySelector('#analyze'),
  analyzeText: document.querySelector('#analyze-text'),
  status: document.querySelector('#status'),
  emptyState: document.querySelector('#empty-state'),
  emptyTitle: document.querySelector('#empty-title'),
  emptyCopy: document.querySelector('#empty-copy'),
  mediaCard: document.querySelector('#media-card'),
  thumbnail: document.querySelector('#thumbnail'),
  sourceHost: document.querySelector('#source-host'),
  uploader: document.querySelector('#uploader'),
  title: document.querySelector('#title'),
  meta: document.querySelector('#meta'),
  videoField: document.querySelector('#video-field'),
  audioField: document.querySelector('#audio-field'),
  audioOutputField: document.querySelector('#audio-output-field'),
  videoFormat: document.querySelector('#video-format'),
  audioFormat: document.querySelector('#audio-format'),
  audioOutput: document.querySelector('#audio-output'),
  selectionNote: document.querySelector('#selection-note'),
  folder: document.querySelector('#folder'),
  chooseFolder: document.querySelector('#choose-folder'),
  download: document.querySelector('#download'),
  downloadText: document.querySelector('#download-text'),
  cancel: document.querySelector('#cancel'),
  openFolder: document.querySelector('#open-folder'),
  progressWrap: document.querySelector('#progress-wrap'),
  progressTrack: document.querySelector('#progress-track'),
  progressLabel: document.querySelector('#progress-label'),
  progressDetail: document.querySelector('#progress-detail'),
  progressBar: document.querySelector('#progress-bar'),
  log: document.querySelector('#log'),
  stepAnalyze: document.querySelector('#step-analyze'),
  stepFormat: document.querySelector('#step-format'),
  stepSave: document.querySelector('#step-save')
};

let mode = 'combined';
let media = null;
let analyzing = false;
let downloading = false;

function setStatus(message, type = '') {
  elements.status.textContent = message;
  elements.status.className = `status ${type}`.trim();
}

function setWorkflow(step, state = 'current') {
  const steps = [elements.stepAnalyze, elements.stepFormat, elements.stepSave];
  steps.forEach((element, index) => {
    const position = index + 1;
    const nextState = position < step ? 'complete' : position === step ? state : 'pending';
    element.dataset.state = nextState;
    element.classList.toggle('active', nextState === 'current');
  });
}

function setEmptyState(state, title, copy) {
  elements.emptyState.dataset.state = state;
  elements.emptyTitle.textContent = title;
  elements.emptyCopy.textContent = copy;
  elements.emptyState.classList.remove('hidden');
}

function hideMediaResult() {
  media = null;
  elements.mediaCard.classList.add('hidden');
  elements.openFolder.classList.add('hidden');
  setWorkflow(1);
}

function formatDuration(seconds) {
  if (!seconds) return '时长未知';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return [h, m, s]
    .filter((_, index) => h > 0 || index > 0)
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
}

function videoLabel(item) {
  const details = [
    item.resolution,
    item.fps ? `${item.fps} FPS` : '',
    item.ext.toUpperCase(),
    item.codec,
    item.hasAudio ? '自带音频' : '纯视频',
    item.size
  ].filter(Boolean);
  return details.join(' · ');
}

function audioLabel(item) {
  const details = [
    item.abr ? `${Math.round(item.abr)} kbps` : '码率未知',
    item.ext.toUpperCase(),
    item.codec,
    item.language,
    item.size
  ].filter(Boolean);
  return details.join(' · ');
}

function populateSelect(select, items, labeler, emptyText) {
  select.replaceChildren();
  if (!items.length) {
    const option = new Option(emptyText, '');
    option.disabled = true;
    option.selected = true;
    select.add(option);
    return;
  }
  items.forEach((item) => select.add(new Option(labeler(item), item.id)));
}

function selectedVideo() {
  return media?.videos.find((item) => item.id === elements.videoFormat.value) || null;
}

function selectedAudio() {
  return media?.audios.find((item) => item.id === elements.audioFormat.value) || null;
}

function chooseCompatibleAudio() {
  const video = selectedVideo();
  if (!video || video.hasAudio || !media?.audios.length) return;
  const preferred = video.ext === 'mp4'
    ? media.audios.find((item) => ['m4a', 'mp4', 'aac'].includes(item.ext.toLowerCase()))
    : null;
  if (preferred) elements.audioFormat.value = preferred.id;
}

function syncFormatState() {
  const video = selectedVideo();
  const audio = selectedAudio();
  const videoHasAudio = Boolean(video?.hasAudio);

  elements.videoField.classList.toggle('hidden', mode === 'audio');
  elements.audioField.classList.toggle('hidden', mode === 'video' || (mode === 'combined' && videoHasAudio));
  elements.audioOutputField.classList.toggle('hidden', mode !== 'audio');
  elements.audioField.classList.toggle('is-disabled', mode === 'combined' && videoHasAudio);

  if (mode === 'combined') {
    elements.downloadText.textContent = '下载视频与音频';
    if (videoHasAudio) {
      elements.selectionNote.textContent = '所选视频已自带音频，将直接保存源格式，不会重复合并音轨。';
    } else if (video && audio) {
      const mp4Compatible = video.ext.toLowerCase() === 'mp4'
        && ['m4a', 'mp4', 'aac'].includes(audio.ext.toLowerCase());
      elements.selectionNote.textContent = mp4Compatible
        ? '视频与音频将合并为 MP4 文件。'
        : '当前编码组合将合并为 MKV，避免转码损失和兼容性错误。';
    } else {
      elements.selectionNote.textContent = '请选择可用的视频与音频格式。';
    }
  } else if (mode === 'video') {
    elements.downloadText.textContent = '仅下载视频';
    elements.selectionNote.textContent = videoHasAudio
      ? '该源格式自带音轨；为避免重新转码，保存后仍会保留音频。'
      : '将保存纯视频轨道，不额外合并音频。';
  } else {
    elements.downloadText.textContent = '仅下载音频';
    elements.selectionNote.textContent = `音频将转换为 ${elements.audioOutput.value.toUpperCase()}。`;
  }
}

function setMode(nextMode) {
  if (!['combined', 'video', 'audio'].includes(nextMode)) return;
  mode = nextMode;
  document.querySelectorAll('.mode').forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  });
  syncFormatState();
}

function setAnalyzeBusy(busy) {
  analyzing = busy;
  elements.analyze.disabled = busy;
  elements.paste.disabled = busy;
  elements.analyze.dataset.busy = String(busy);
  elements.analyzeText.textContent = busy ? '正在解析' : '解析链接';
}

function setProgress(percent) {
  const safePercent = Math.max(0, Math.min(100, percent));
  elements.progressBar.style.width = `${safePercent}%`;
  elements.progressTrack.setAttribute('aria-valuenow', String(Math.round(safePercent)));
}

function safeHost(value) {
  try {
    return new URL(value).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function restoreFolder() {
  try {
    elements.folder.value = localStorage.getItem('qingying:last-folder') || '';
  } catch {
    elements.folder.value = '';
  }
}

function rememberFolder(folder) {
  try {
    localStorage.setItem('qingying:last-folder', folder);
  } catch {}
}

async function analyze() {
  if (analyzing || downloading) return;
  const url = elements.url.value.trim();
  if (!url) {
    elements.url.focus();
    return setStatus('请先粘贴视频网址。', 'error');
  }

  hideMediaResult();
  setAnalyzeBusy(true);
  setEmptyState('loading', '正在读取可用格式', '不同网站所需时间不同，请保持窗口开启。');
  setStatus('正在连接网站…');

  try {
    const result = await window.qingying.analyze(url);
    if (!result?.ok) {
      setEmptyState('error', '暂时无法解析这个链接', '检查链接是否公开、网站是否受支持，或按提示完成登录。');
      return setStatus(result?.error || '解析失败，请稍后重试。', 'error');
    }

    media = result.data;
    const imageCount = Array.isArray(media.images) ? media.images.length : 0;
    const imagesOnly = imageCount > 0 && !media.videos.length && !media.audios.length;
    if (!media.videos.length && !media.audios.length && !imageCount) {
      setEmptyState('error', '没有找到可下载格式', '这个页面可能没有视频或图片，或内容受保护。');
      media = null;
      return setStatus('没有找到可下载的视频、音频或图片。', 'error');
    }

    document.querySelector('.mode-tabs').classList.toggle('hidden', imagesOnly);
    document.querySelector('#format-panel').classList.toggle('hidden', imagesOnly);

    elements.thumbnail.src = media.thumbnail || '';
    elements.thumbnail.alt = media.thumbnail ? `${media.title} 的缩略图` : '';
    elements.thumbnail.classList.toggle('hidden', !media.thumbnail);
    elements.sourceHost.textContent = safeHost(media.webpageUrl);
    elements.sourceHost.classList.toggle('hidden', !elements.sourceHost.textContent || !media.thumbnail);
    elements.uploader.textContent = media.uploader || '作品信息';
    elements.title.textContent = media.title;
    elements.meta.textContent = imagesOnly
      ? `${imageCount} 张图片 · 可直接保存原图`
      : `${formatDuration(media.duration)} · ${media.videos.length} 个视频格式 · ${media.audios.length} 个音频格式`;
    populateSelect(elements.videoFormat, media.videos, videoLabel, '没有独立视频格式');
    populateSelect(elements.audioFormat, media.audios, audioLabel, '没有独立音频格式');

    if (imagesOnly) {
      elements.selectionNote.textContent = `共 ${imageCount} 张图片，将按顺序保存原图，不需要选择格式。`;
      elements.downloadText.textContent = '下载全部图片';
      elements.emptyState.classList.add('hidden');
      elements.mediaCard.classList.remove('hidden');
      elements.openFolder.classList.add('hidden');
      setWorkflow(2);
      setStatus('图片解析完成，可以直接下载。', 'success');
      return;
    }

    const audioModeButton = document.querySelector('.mode[data-mode="audio"]');
    const combinedModeButton = document.querySelector('.mode[data-mode="combined"]');
    const videoModeButton = document.querySelector('.mode[data-mode="video"]');
    audioModeButton.disabled = media.audios.length === 0;
    videoModeButton.disabled = media.videos.length === 0;
    combinedModeButton.disabled = media.videos.length === 0;
    audioModeButton.title = media.audios.length === 0 ? '该网站没有独立音轨' : '';

    if (!media.videos.length) {
      setMode('audio');
    } else if (mode === 'audio' && !media.audios.length) {
      setMode('combined');
    }
    chooseCompatibleAudio();
    syncFormatState();
    elements.emptyState.classList.add('hidden');
    elements.mediaCard.classList.remove('hidden');
    elements.openFolder.classList.add('hidden');
    setWorkflow(2);
    setStatus('解析完成，可以选择格式和保存位置。', 'success');
  } catch (error) {
    setEmptyState('error', '解析过程意外中断', '请检查网络后重试；如果持续出现，可重启应用。');
    setStatus(error?.message || '解析过程意外中断。', 'error');
  } finally {
    setAnalyzeBusy(false);
  }
}

async function startDownload() {
  if (downloading) return;
  if (!media) return setStatus('请先解析视频网址。', 'error');
  if (!elements.folder.value) return setStatus('请选择保存文件夹。', 'error');

  const imagesOnly = Array.isArray(media.images) && media.images.length > 0
    && !media.videos.length && !media.audios.length;

  const video = selectedVideo();
  const audio = selectedAudio();
  if (!imagesOnly && mode !== 'audio' && !video) return setStatus('请选择视频画质。', 'error');
  if (!imagesOnly && mode === 'audio' && !audio) return setStatus('请选择音频轨道。', 'error');
  if (!imagesOnly && mode === 'combined' && !video?.hasAudio && !audio) {
    return setStatus('请选择用于合并的音频轨道。', 'error');
  }

  downloading = true;
  elements.download.disabled = true;
  elements.chooseFolder.disabled = true;
  elements.cancel.disabled = false;
  elements.cancel.classList.remove('hidden');
  elements.openFolder.classList.add('hidden');
  elements.progressWrap.classList.remove('hidden');
  setProgress(0);
  elements.progressLabel.textContent = '准备下载…';
  elements.progressDetail.textContent = '';
  elements.log.textContent = '';
  setWorkflow(3);
  setStatus('下载任务已开始。');

  try {
    const result = await window.qingying.startDownload(imagesOnly ? {
      url: media.webpageUrl,
      outputDir: elements.folder.value,
      mode: 'images',
      images: media.images,
      title: media.title,
      sessionSite: media.sessionSite || ''
    } : {
      url: media.webpageUrl,
      outputDir: elements.folder.value,
      mode,
      videoId: video?.id || '',
      videoExt: video?.ext || '',
      videoHasAudio: Boolean(video?.hasAudio),
      audioId: audio?.id || '',
      audioExt: audio?.ext || '',
      audioFormat: elements.audioOutput.value,
      sessionSite: media.sessionSite || ''
    });
    if (!result?.ok && !result?.cancelled) {
      setStatus(result?.error || '下载失败，请重试。', 'error');
      elements.progressLabel.textContent = '下载失败';
      setWorkflow(3, 'current');
    }
  } catch (error) {
    setStatus(error?.message || '下载过程意外中断。', 'error');
    elements.progressLabel.textContent = '下载失败';
  } finally {
    downloading = false;
    elements.download.disabled = false;
    elements.chooseFolder.disabled = false;
    elements.cancel.classList.add('hidden');
  }
}

elements.paste.addEventListener('click', async () => {
  try {
    const clipboardText = await window.qingying.readClipboard();
    elements.url.value = clipboardText.trim();
    hideMediaResult();
    setEmptyState('idle', '链接已粘贴', '确认网址无误后，点击“解析链接”。');
    setStatus(elements.url.value ? '已从剪贴板读取链接。' : '剪贴板里没有文字。');
    elements.url.focus();
  } catch {
    setStatus('无法读取剪贴板。', 'error');
  }
});

elements.douyinLogin.addEventListener('click', async () => {
  try {
    await window.qingying.openDouyinLogin();
    setStatus('请在弹出的抖音窗口中完成登录，登录后关闭该窗口。');
  } catch {
    setStatus('无法打开抖音登录窗口。', 'error');
  }
});

elements.tiktokLogin.addEventListener('click', async () => {
  try {
    await window.qingying.openTiktokLogin();
    setStatus('请在弹出的 TikTok 窗口中完成登录，登录后关闭该窗口。');
  } catch {
    setStatus('无法打开 TikTok 登录窗口。', 'error');
  }
});

elements.bilibiliLogin.addEventListener('click', async () => {
  try {
    await window.qingying.openBilibiliLogin();
    setStatus('请在弹出的哔哩哔哩窗口中登录（或仅打开页面完成授权），然后关闭该窗口。');
  } catch {
    setStatus('无法打开哔哩哔哩登录窗口。', 'error');
  }
});

elements.xiaohongshuLogin.addEventListener('click', async () => {
  try {
    await window.qingying.openXiaohongshuLogin();
    setStatus('请在弹出的小红书窗口中完成登录，登录后关闭该窗口。');
  } catch {
    setStatus('无法打开小红书登录窗口。', 'error');
  }
});

elements.instagramLogin.addEventListener('click', async () => {
  try {
    await window.qingying.openInstagramLogin();
    setStatus('请在弹出的 Instagram 窗口中完成登录，登录后关闭该窗口。');
  } catch {
    setStatus('无法打开 Instagram 登录窗口。', 'error');
  }
});

function listenLoginStatus(apiMethod, siteName) {
  return window.qingying[apiMethod](({ loggedIn }) => {
    setStatus(
      loggedIn ? `${siteName}登录成功，现在可以解析链接。` : `没有检测到${siteName}登录，请重新登录。`,
      loggedIn ? 'success' : 'error'
    );
  });
}

const removeDouyinLoginListener = listenLoginStatus('onDouyinLoginStatus', '抖音');
const removeTiktokLoginListener = listenLoginStatus('onTiktokLoginStatus', 'TikTok');
const removeBilibiliLoginListener = listenLoginStatus('onBilibiliLoginStatus', '哔哩哔哩');
const removeXiaohongshuLoginListener = listenLoginStatus('onXiaohongshuLoginStatus', '小红书');
const removeInstagramLoginListener = listenLoginStatus('onInstagramLoginStatus', 'Instagram');

elements.analyze.addEventListener('click', analyze);
elements.url.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    analyze();
  }
});
elements.url.addEventListener('input', () => {
  if (media && elements.url.value.trim() !== media.webpageUrl) {
    hideMediaResult();
    setEmptyState('idle', '链接已更改', '请重新解析，避免下载上一次的内容。');
    setStatus('链接已更改，请重新解析。');
  }
});

document.querySelectorAll('.mode').forEach((button) => {
  button.addEventListener('click', () => setMode(button.dataset.mode));
  button.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const enabledTabs = [...document.querySelectorAll('.mode:not(:disabled)')];
    const current = enabledTabs.indexOf(button);
    const offset = event.key === 'ArrowRight' ? 1 : -1;
    const next = enabledTabs[(current + offset + enabledTabs.length) % enabledTabs.length];
    setMode(next.dataset.mode);
    next.focus();
  });
});

elements.videoFormat.addEventListener('change', () => {
  chooseCompatibleAudio();
  syncFormatState();
});
elements.audioFormat.addEventListener('change', syncFormatState);
elements.audioOutput.addEventListener('change', syncFormatState);

elements.chooseFolder.addEventListener('click', async () => {
  try {
    const folder = await window.qingying.chooseFolder();
    if (folder) {
      elements.folder.value = folder;
      rememberFolder(folder);
      setStatus('保存位置已选择。', 'success');
    }
  } catch {
    setStatus('无法打开文件夹选择窗口。', 'error');
  }
});

elements.download.addEventListener('click', startDownload);
elements.cancel.addEventListener('click', async () => {
  if (!downloading) return;
  elements.cancel.disabled = true;
  elements.progressLabel.textContent = '正在取消…';
  setStatus('正在停止下载任务。');
  try {
    const cancelled = await window.qingying.cancelDownload();
    if (!cancelled) setStatus('下载任务已经结束。');
  } catch {
    elements.cancel.disabled = false;
    setStatus('取消失败，请稍后再试。', 'error');
  }
});

elements.openFolder.addEventListener('click', async () => {
  const opened = await window.qingying.openFolder(elements.folder.value);
  if (!opened) setStatus('保存文件夹不存在或无法打开。', 'error');
});

const removeProgressListener = window.qingying.onProgress((payload) => {
  if (payload.type === 'progress') {
    const percent = Number.parseFloat(payload.percent) || 0;
    setProgress(percent);
    elements.progressLabel.textContent = `下载中 ${payload.percent}`;
    elements.progressDetail.textContent =
      [payload.speed, payload.eta ? `剩余 ${payload.eta}` : ''].filter(Boolean).join(' · ');
  } else if (payload.type === 'done') {
    setProgress(100);
    elements.progressLabel.textContent = '下载完成';
    elements.progressDetail.textContent = '';
    elements.openFolder.classList.remove('hidden');
    setWorkflow(3, 'complete');
    setStatus('文件已保存。', 'success');
  } else if (payload.type === 'cancelled') {
    elements.progressLabel.textContent = '下载已取消';
    elements.progressDetail.textContent = '';
    setWorkflow(3, 'current');
    setStatus('下载已取消。');
  } else if (payload.message) {
    elements.log.textContent = payload.message;
  }
});

restoreFolder();
setMode('combined');

window.qingying.getAppInfo()
  .then((info) => {
    if (info?.version) elements.appVersion.textContent = `v${info.version}`;
  })
  .catch(() => {});

window.addEventListener('beforeunload', () => {
  removeProgressListener();
  removeDouyinLoginListener();
  removeTiktokLoginListener();
  removeBilibiliLoginListener();
  removeXiaohongshuLoginListener();
  removeInstagramLoginListener();
});
