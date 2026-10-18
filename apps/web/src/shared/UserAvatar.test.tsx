import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { UserAvatar } from './UserAvatar';

const PHOTO = 'https://lh3.googleusercontent.com/a/ACg8oc-ada=s96-c';
const NEXT_PHOTO = 'https://lh3.googleusercontent.com/a/ACg8oc-next=s96-c';

const image = (container: HTMLElement) => container.querySelector('img');

describe('UserAvatar', () => {
  it('renders a decorative, no-referrer image with the initials footprint', () => {
    const { container } = render(<UserAvatar name="Ada Lovelace" seed="u1" avatarUrl={PHOTO} size="sm" />);
    const img = image(container);
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute('src', PHOTO);
    expect(img).toHaveAttribute('alt', '');
    expect(img).toHaveAttribute('aria-hidden', 'true');
    expect(img).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(img).toHaveAttribute('width', '24');
    expect(img).toHaveAttribute('height', '24');
    expect(img).toHaveClass('size-6', 'rounded-full');
    expect(container).not.toHaveTextContent('AL');
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['http', 'http://lh3.googleusercontent.com/a/x'],
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:image/png;base64,AAAA'],
    ['loopback', 'https://127.0.0.1/a.png'],
    ['token query', 'https://photos.example.com/a.png?token=secret'],
  ])('renders hidden initials and no image for a %s URL', (_label, avatarUrl) => {
    const { container } = render(<UserAvatar name="Ada Lovelace" seed="u1" avatarUrl={avatarUrl} />);
    expect(image(container)).toBeNull();
    const initials = container.firstElementChild;
    expect(initials).toHaveTextContent('AL');
    expect(initials).toHaveAttribute('aria-hidden', 'true');
    expect(initials).toHaveClass('size-8');
  });

  it('falls back to initials when the image fails and stays there for the same URL', () => {
    const { container, rerender } = render(<UserAvatar name="Ada Lovelace" seed="u1" avatarUrl={PHOTO} />);
    const img = image(container);
    if (img === null) throw new Error('missing image');
    fireEvent.error(img);
    expect(image(container)).toBeNull();
    expect(container).toHaveTextContent('AL');

    rerender(<UserAvatar name="Ada Lovelace" seed="u1" avatarUrl={PHOTO} />);
    expect(image(container)).toBeNull();
    expect(container).toHaveTextContent('AL');
  });

  it('retries with a new image when the URL changes after a failure', () => {
    const { container, rerender } = render(<UserAvatar name="Ada Lovelace" seed="u1" avatarUrl={PHOTO} size="lg" />);
    const img = image(container);
    if (img === null) throw new Error('missing image');
    fireEvent.error(img);
    expect(image(container)).toBeNull();

    rerender(<UserAvatar name="Ada Lovelace" seed="u1" avatarUrl={NEXT_PHOTO} size="lg" />);
    expect(image(container)).toHaveAttribute('src', NEXT_PHOTO);
    expect(image(container)).toHaveClass('size-10');
    expect(container).not.toHaveTextContent('AL');
  });
});
