import type { ComponentType } from 'react';

interface AeroShardsProps {
  backgroundColor?: string;
  shardColor?: string;
  accentColor?: string;
  placement?: 'right' | 'left' | 'center' | 'full';
  material?: 'pearl' | 'chrome' | 'satin';
  detail?: 'bold' | 'balanced' | 'fine';
  flow?: 'stream' | 'vortex' | 'ribbon';
  effect?: 'none' | 'dither' | 'ascii';
  scale?: number;
  spread?: number;
  depth?: number;
  speed?: number;
  spin?: number;
  interaction?: 'none' | 'repel' | 'attract';
  density?: number;
  shardSize?: number;
  stretch?: number;
  turbulence?: number;
  glow?: number;
  edgeSoftness?: number;
  bloom?: number;
  grain?: number;
  chromaticAberration?: number;
  transitionDuration?: number;
  interactionRadius?: number;
  interactionStrength?: number;
  rippleIntensity?: number;
  holdToGather?: boolean;
  paused?: boolean;
  className?: string;
  onError?: (error: Error) => void;
}

declare const AeroShards: ComponentType<AeroShardsProps>;
export default AeroShards;
