import vulture256 from "../../assets/brand/vulture-256.png";
import vulture512 from "../../assets/brand/vulture-512.png";

export interface BrandMarkProps {
  /** Square edge length in CSS pixels. The image is rendered at exactly
   * this size; @2x density is provided via srcSet so retina screens
   * still pick the 512 raster. */
  size?: number;
  /**
   * Decorative mark next to a sibling brand label has no a11y value;
   * pass empty string (the default) to leave it as `aria-hidden`. Pass
   * a real label when the mark stands alone (rare). */
  alt?: string;
  /** Class applied to the wrapping `<span>` so callers can layer their
   * own halo / shadow without touching the image element. */
  className?: string;
}

/**
 * App brand icon — the rounded vulture mascot used at every "this is
 * Vulture" moment (sidebar, onboarding, empty-state hero, etc.).
 *
 * Renders as a square image with a rounded mask + a hairline ring so
 * the icon still reads as an "app icon" against any backplate. The
 * image keeps its own internal background colour, so we deliberately
 * do NOT fill the wrapper — that would clip the badge into a coloured
 * square that fights the icon's intrinsic palette.
 */
export function BrandMark({ size = 32, alt = "", className }: BrandMarkProps) {
  const decorative = alt === "";
  return (
    <span
      className={`brand-mark-img${className ? ` ${className}` : ""}`}
      style={{ width: size, height: size }}
      aria-hidden={decorative ? true : undefined}
    >
      <img
        src={vulture256}
        srcSet={`${vulture256} 1x, ${vulture512} 2x`}
        width={size}
        height={size}
        alt={decorative ? "" : alt}
        draggable={false}
      />
    </span>
  );
}
