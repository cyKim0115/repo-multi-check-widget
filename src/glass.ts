import type { RepoConfig } from "./types";

/** 흐림 반경 상한(CSS px). glass.rs의 MAX_BLUR_PX, 설정 슬라이더 max와 같아야 한다. */
export const MAX_GLASS_BLUR = 32;
/** glass.rs의 DEFAULT_BLUR_PX와 같아야 한다. */
export const DEFAULT_GLASS_BLUR = 12;

/** 지원하지 않는 Windows에서는 Rust가 알아서 끄므로, 값이 없으면 켬으로 본다. */
export function glassEnabled(config: RepoConfig): boolean {
  return config.glass ?? true;
}

export function glassBlur(config: RepoConfig): number {
  const value = config.glass_blur ?? DEFAULT_GLASS_BLUR;
  return Number.isFinite(value) ? Math.min(MAX_GLASS_BLUR, Math.max(0, value)) : DEFAULT_GLASS_BLUR;
}
