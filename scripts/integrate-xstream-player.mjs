import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const filePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../frontend/src/components/VideoPage.jsx');
let s = fs.readFileSync(filePath, 'utf8');

if (!s.includes("import XStreamPlayer from './player/XStreamPlayer.jsx'")) {
  s = s.replace(
    "import { motion, AnimatePresence } from 'framer-motion';\nimport VideoCard from './VideoCard.jsx';",
    "import { motion, AnimatePresence } from 'framer-motion';\nimport XStreamPlayer from './player/XStreamPlayer.jsx';\nimport UpNextSidebar from './player/sidebar/UpNextSidebar.jsx';",
  );
}

if (!s.includes('registerVideoRef')) {
  s = s.replace(
    '  const playMainVideo = useRef(() => { });',
    `  const registerVideoRef = useCallback((el) => {
    mainVideoRef.current = el;
  }, []);

  const playMainVideo = useRef(() => { });`,
  );
}

if (!s.includes('useEffect(() => {\n    const adEl = adVideoRef.current')) {
  s = s.replace(
    '  const safeEmbedUrl = isAllowedEmbedUrl',
    `  useEffect(() => {
    const adEl = adVideoRef.current;
    if (!adEl || !isAdPlaying) return undefined;
    const onEnd = () => stopAdAndPlayMain();
    const onWait = () => setIsAdBuffering(true);
    const onPlay = () => setIsAdBuffering(false);
    adEl.addEventListener('ended', onEnd);
    adEl.addEventListener('waiting', onWait);
    adEl.addEventListener('playing', onPlay);
    adEl.addEventListener('canplay', onPlay);
    return () => {
      adEl.removeEventListener('ended', onEnd);
      adEl.removeEventListener('waiting', onWait);
      adEl.removeEventListener('playing', onPlay);
      adEl.removeEventListener('canplay', onPlay);
    };
  }, [isAdPlaying, adToPlay]);

  const safeEmbedUrl = isAllowedEmbedUrl`,
  );
}

const playerStart = s.indexOf('          {/* Video Player: main video or embed */}');
const playerEnd = s.indexOf('          {/* Video Info */}');
if (playerStart !== -1 && playerEnd !== -1 && !s.includes('<XStreamPlayer')) {
  const playerBlock = `          <XStreamPlayer
            mode="vod"
            className="mb-4"
            videoSrc={mainVideoSrcState && isValidVideoUrl(mainVideoSrcState) ? mainVideoSrcState : ''}
            embedUrl={safeEmbedUrl}
            poster={thumbnailSrc}
            videoId={stableVideoId}
            chapters={activeVideo?.chapters || []}
            isUnavailable={isUnavailable}
            errorMessage={controllerError || ''}
            loadingExternal={controllerLoading}
            onRetry={fetchStreamFromController}
            isPreviewClip={isPreviewClip}
            adSrc={adToPlay || ''}
            adType={currentAd?.type || 'video'}
            isAdPlaying={isAdPlaying}
            showAdSkip={showSkipButton}
            onAdSkip={stopAdAndPlayMain}
            onAdClick={() => currentAd?.id && onAdClick(currentAd.id)}
            adClickUrl={currentAd?.clickUrl || ''}
            adEndedOrSkipped={adEndedOrSkipped}
            onIntroPlay={handlePlayClick}
            adVideoRef={adVideoRef}
            registerVideoRef={registerVideoRef}
            isVideoLocked={isVideoLocked}
            premiumLimitReached={premiumLimitReached}
            premiumPreviewElapsed={premiumPreviewElapsed}
            premiumPreviewLimit={PREMIUM_PREVIEW_LIMIT}
            purchaseCheckDone={purchaseCheckDone}
            premiumGate={{
              tokenPrice,
              displayTokenBalance,
              hasEnoughTokens,
              isAuthenticated,
              isPurchasing,
              purchaseError,
              onPurchase: handlePurchase,
            }}
            onPlayingChange={setMainPlaying}
            nextVideo={relatedVideosToDisplay[0] || null}
            onNextVideo={onVideoClick}
          />

`;
  s = s.slice(0, playerStart) + playerBlock + s.slice(playerEnd);
}

if (!s.includes('<UpNextSidebar')) {
  s = s.replace(
    /        \{\/\* Sidebar \(Related Videos\) \*\/\}[\s\S]*?        <\/div>\r?\n(?=      <\/div>)/,
    `        <UpNextSidebar
          videos={relatedVideosToDisplay}
          loading={fetchingRelated}
          onVideoClick={onVideoClick}
        />
`,
  );
}

fs.writeFileSync(filePath, s);
console.log('done');
