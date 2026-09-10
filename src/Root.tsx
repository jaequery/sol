import { App } from './App';
import { LandingPage } from './LandingPage';

function AuthPlaceholder({ mode }: { mode: 'login' | 'sign-up' }) {
  const title = mode === 'login' ? 'Log in to SolCut' : 'Create your SolCut account';
  const detail = mode === 'login' ? 'Account access is coming soon.' : 'Sign-up is coming soon.';

  return (
    <main className="auth-placeholder">
      <a className="landing-brand" href="/" aria-label="SolCut home">
        <span className="landing-brand__mark" aria-hidden="true">S</span>
        <span>SolCut</span>
      </a>
      <div className="auth-placeholder__card">
        <p className="landing-kicker">SolCut</p>
        <h1>{title}</h1>
        <p>{detail} Return to the landing page to explore the editor.</p>
        <a className="landing-button landing-button--primary" href="/">Back home</a>
      </div>
    </main>
  );
}

export function Root() {
  const path = window.location.pathname.replace(/\/$/, '') || '/';

  if (path === '/') return <LandingPage />;
  if (path === '/editor') return <App />;
  if (path === '/login') return <AuthPlaceholder mode="login" />;
  if (path === '/sign-up') return <AuthPlaceholder mode="sign-up" />;

  return <LandingPage />;
}
