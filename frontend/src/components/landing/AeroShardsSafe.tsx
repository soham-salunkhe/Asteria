import { useCallback, useState, type ComponentProps } from 'react';
import AeroShardsWebGPU from './AeroShardsWebGPU';
import AeroShardsCanvas from './AeroShards';

type AeroShardsProps = ComponentProps<typeof AeroShardsWebGPU>;

function supportsWebGPU() {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

export default function AeroShardsSafe({ onError, ...props }: AeroShardsProps) {
  const [useCanvasFallback, setUseCanvasFallback] = useState(() => !supportsWebGPU());

  const handleWebGPUError = useCallback(
    (error: Error) => {
      console.warn('[AeroShards] WebGPU unavailable; using canvas fallback.', error);
      setUseCanvasFallback(true);
      onError?.(error);
    },
    [onError],
  );

  if (useCanvasFallback) {
    return <AeroShardsCanvas {...props} />;
  }

  return <AeroShardsWebGPU {...props} onError={handleWebGPUError} />;
}
