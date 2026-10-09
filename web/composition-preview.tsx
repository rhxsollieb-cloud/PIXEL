import { useEffect, useMemo, useRef } from 'react';
import { Player, type CallbackListener, type PlayerRef } from '@remotion/player';
import { AbsoluteFill, Html5Audio, Html5Video, Img, Sequence } from 'remotion';
import type { DeepReadonly, ProjectSnapshot } from '../src/contracts.js';
import { assetUrl } from './bridge.js';
import { buildCompositionPlan, COMPOSITION_HEIGHT, COMPOSITION_WIDTH, compositionFrameAtMs, type CompositionPlan } from './composition.js';
import './composition-preview.css';

interface PictureProps extends Record<string, unknown> { plan: CompositionPlan; }

function TimelinePicture({ plan }: PictureProps) {
  return <AbsoluteFill className="composition-picture">
    {plan.layers.map(layer => <Sequence key={layer.itemId} from={layer.from} durationInFrames={layer.durationInFrames} layout="none">
      {layer.kind === 'audio'
        ? <Html5Audio src={assetUrl(layer.assetId)} trimBefore={layer.trimBefore} durationInFrames={layer.durationInFrames} pauseWhenBuffering draggable={false} data-composition-item={layer.itemId} />
        : <AbsoluteFill data-composition-item={layer.itemId} data-composition-timeline={layer.timelineId} style={{ zIndex: layer.zIndex }}>
          {layer.kind === 'video'
            ? <Html5Video src={assetUrl(layer.assetId)} trimBefore={layer.trimBefore} durationInFrames={layer.durationInFrames} pauseWhenBuffering acceptableTimeShiftInSeconds={1 / plan.fps} draggable={false} className="composition-media" />
            : <Img src={assetUrl(layer.assetId)} draggable={false} className="composition-media" />}
        </AbsoluteFill>}
    </Sequence>)}
  </AbsoluteFill>;
}

export interface CompositionPreviewProps {
  snapshot: DeepReadonly<ProjectSnapshot>;
  playheadMs: number;
  onSeek(milliseconds: number): void;
}

/** Player controls and the timeline pointer share one viewport clock, without creating project Actions. */
export function CompositionPreview({ snapshot, playheadMs, onSeek }: CompositionPreviewProps) {
  const player = useRef<PlayerRef>(null);
  const onSeekRef = useRef(onSeek); onSeekRef.current = onSeek;
  const plan = useMemo(() => buildCompositionPlan(snapshot.document), [snapshot.document]);
  const inputProps = useMemo(() => ({ plan }), [plan]);
  const lastEmittedFrame = useRef<number | undefined>(undefined);
  const externalSeek = useRef(false);
  useEffect(() => {
    const instance = player.current;
    if (!instance) return;
    const update: CallbackListener<'frameupdate'> = event => {
      const frame = event.detail.frame;
      if (externalSeek.current || frame === lastEmittedFrame.current) return;
      lastEmittedFrame.current = frame;
      onSeekRef.current(Math.round(frame * 1000 / plan.fps));
    };
    instance.addEventListener('frameupdate', update);
    return () => instance.removeEventListener('frameupdate', update);
  }, [plan.fps]);
  useEffect(() => {
    const instance = player.current;
    if (!instance) return;
    const desired = compositionFrameAtMs(plan, playheadMs);
    if (instance.getCurrentFrame() === desired) return;
    externalSeek.current = true;
    instance.seekTo(desired);
    lastEmittedFrame.current = desired;
    externalSeek.current = false;
  }, [playheadMs, plan]);
  return <div className="composition-preview" aria-label="作品叠加预览">
    <Player ref={player} component={TimelinePicture} inputProps={inputProps}
      durationInFrames={plan.durationInFrames} fps={plan.fps} compositionWidth={COMPOSITION_WIDTH} compositionHeight={COMPOSITION_HEIGHT}
      initialFrame={compositionFrameAtMs(plan, playheadMs)} controls alwaysShowControls allowFullscreen={false}
      moveToBeginningWhenEnded={false} clickToPlay={false} doubleClickToFullscreen={false}
      numberOfSharedAudioTags={0} className="composition-player" style={{ width: '100%', height: '100%' }}
      errorFallback={() => <div className="composition-error" role="status">预览暂不可用，请检查素材文件。</div>} />
  </div>;
}
