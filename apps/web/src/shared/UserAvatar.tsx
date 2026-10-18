import { safeProfilePhotoUrl } from '@workloom/contracts';
import { Avatar, cn } from '@workloom/ui';
import { useState } from 'react';

/** Same footprint as the initials Avatar sizes, so swapping image and initials never shifts layout. */
const sizes = {
  sm: { className: 'size-6', pixels: 24 },
  md: { className: 'size-8', pixels: 32 },
  lg: { className: 'size-10', pixels: 40 },
} as const;

export interface UserAvatarProps {
  name: string;
  seed?: string | undefined;
  /** Verified profile photo; unsafe, missing or failing URLs fall back to initials. */
  avatarUrl?: string | null | undefined;
  size?: keyof typeof sizes | undefined;
  shape?: 'circle' | 'square' | undefined;
  className?: string | undefined;
}

/**
 * Decorative person avatar: the profile photo when it loads, otherwise the
 * initials Avatar. Always render the name as text next to it. The browser
 * loads the image directly without a referrer; Workloom never fetches it.
 */
export function UserAvatar({ name, seed, avatarUrl, size = 'md', shape = 'circle', className }: UserAvatarProps) {
  const src = safeProfilePhotoUrl(avatarUrl);
  // Keyed by URL rather than reset in an effect: a new URL retries, the failed one stays on initials.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  if (src === null || src === failedSrc) {
    return <Avatar name={name} seed={seed} size={size} shape={shape} className={className} />;
  }
  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      referrerPolicy="no-referrer"
      decoding="async"
      draggable={false}
      width={sizes[size].pixels}
      height={sizes[size].pixels}
      className={cn('shrink-0 object-cover select-none', shape === 'circle' ? 'rounded-full' : 'rounded-lg', sizes[size].className, className)}
      onError={() => setFailedSrc(src)}
    />
  );
}
