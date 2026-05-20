import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const filePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../frontend/src/components/VideoPage.jsx');
const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);

const importIdx = lines.findIndex((l) => l.includes("from 'framer-motion'"));
if (importIdx !== -1 && !lines.some((l) => l.includes('XStreamPlayer'))) {
  lines.splice(importIdx + 1, 0, "import XStreamPlayer from './player/XStreamPlayer.jsx';", "import UpNextSidebar from './player/sidebar/UpNextSidebar.jsx';");
}

const playIdx = lines.findIndex((l) => l.includes('const playMainVideo = useRef'));
if (playIdx !== -1 && !lines.some((l) => l.includes('registerVideoRef'))) {
  lines.splice(playIdx, 0, '  const registerVideoRef = useCallback((el) => {', '    mainVideoRef.current = el;', '  }, []);', '');
}

const playerStart = lines.findIndex((l) => l.includes('Video Player: main video'));
const playerEnd = lines.findIndex((l) => l.includes('Video Info'));
if (playerStart !== -1 && playerEnd !== -1 && playerEnd > playerStart) {
  const block = [
    '          <XStreamPlayer',
    '            mode="vod"',
    '            className="mb-4"',
    '            videoSrc={mainVideoSrcState && isValidVideoUrl(mainVideoSrcState) ? mainVideoSrcState : \'\'}',
    '            embedUrl={embedUrlState && !isPornhubEmbedUrl(embedUrlState) ? embedUrlState : \'\'}',
    '            poster={activeVideo?.thumbnail || \'\'}',
    '            videoId={stableVideoId}',
    '            isUnavailable={!hasPlayableSource && !mainVideoSrcState}',
    '            errorMessage={controllerError || \'\'}',
    '            loadingExternal={controllerLoading}',
    '            onRetry={() => void fetchStreamFromController()}',
    '            adSrc={adToPlay || \'\'}',
    '            adType={currentAd?.type || \'video\'}',
    '            isAdPlaying={isAdPlaying}',
    '            showAdSkip={showSkipButton}',
    '            onAdSkip={stopAdAndPlayMain}',
    '            onAdClick={() => currentAd?.id && onAdClick(currentAd.id)}',
    '            adClickUrl={currentAd?.clickUrl || \'\'}',
    '            adEndedOrSkipped={adEndedOrSkipped}',
    '            onIntroPlay={handlePlayClick}',
    '            adVideoRef={adVideoRef}',
    '            registerVideoRef={registerVideoRef}',
    '            isVideoLocked={isVideoLocked}',
    '            premiumLimitReached={premiumLimitReached}',
    '            premiumPreviewElapsed={premiumPreviewElapsed}',
    '            premiumPreviewLimit={12}',
    '            purchaseCheckDone={purchaseCheckDone}',
    '            premiumGate={{',
    '              tokenPrice: Number(activeVideo?.tokenPrice) || 0,',
    '              displayTokenBalance: Number(currentUser?.tokenBalance ?? 0),',
    '              hasEnoughTokens: Number(currentUser?.tokenBalance ?? 0) >= (Number(activeVideo?.tokenPrice) || 0),',
    '              isAuthenticated,',
    '              isPurchasing,',
    '              purchaseError,',
    '              onPurchase: handlePurchase,',
    '            }}',
    '            onPlayingChange={setMainPlaying}',
    '            nextVideo={relatedVideosToDisplay[0] || null}',
    '            onNextVideo={onVideoClick}',
    '          />',
    '',
  ];
  lines.splice(playerStart, playerEnd - playerStart, ...block);
}

const sideStart = lines.findIndex((l) => l.includes('Sidebar (Related Videos)'));
if (sideStart !== -1) {
  let sideEnd = sideStart;
  let depth = 0;
  for (let i = sideStart; i < lines.length; i++) {
    if (lines[i].includes('<div')) depth++;
    if (lines[i].includes('</motion.div>')) depth--;
    if (lines[i].trim() === '</motion.div>' && depth <= 0 && i > sideStart) {
      sideEnd = i;
      break;
    }
    if (lines[i].trim() === '</motion.div>' && i > sideStart + 5) {
      const next = lines[i + 1]?.trim();
      if (next === '</motion.div>') {
        sideEnd = i;
        break;
      }
    }
  }
  if (sideEnd > sideStart) {
    lines.splice(sideStart, sideEnd - sideStart + 1,
      '        <UpNextSidebar',
      '          videos={relatedVideosToDisplay}',
      '          loading={fetchingRelated}',
      '          onVideoClick={onVideoClick}',
      '        />',
    );
  }
}

fs.writeFileSync(filePath, lines.join('\n'));
console.log('lines integrated', { playerStart, playerEnd: lines.findIndex((l) => l.includes('Video Info')), sideStart });
