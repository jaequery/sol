import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LandingPage } from './LandingPage';

describe('landing page', () => {
  afterEach(() => {
    document.body.classList.remove('landing-body');
  });

  it('presents the public story and intentional entry points', () => {
    render(<LandingPage />);

    expect(screen.getByRole('heading', { name: /make the moment/i })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Get started' })[0]).toHaveAttribute('href', '/sign-up');
    expect(screen.getByRole('link', { name: /open the editor/i })).toHaveAttribute('href', '/editor');
    expect(screen.getByRole('heading', { name: /everything you need/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /from first frame/i })).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
  });
});
