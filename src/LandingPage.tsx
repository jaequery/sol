import { useEffect } from 'react';
import heroImage from './assets/solcut-hero.png';

const features = [
  {
    number: '01',
    title: 'Start with the feeling',
    copy: 'Bring your photos, clips, and sound into one focused timeline before the edit gets complicated.',
  },
  {
    number: '02',
    title: 'Let the in-between breathe',
    copy: 'Generate transitions that connect the moments you already chose, with direction you can shape.',
  },
  {
    number: '03',
    title: 'Finish with intention',
    copy: 'Tune the frame, sound, and pacing in a workspace that keeps the story in view.',
  },
];

export function LandingPage() {
  useEffect(() => {
    document.body.classList.add('landing-body');
    return () => document.body.classList.remove('landing-body');
  }, []);

  return (
    <div className="landing">
      <header className="landing-nav">
        <a className="landing-brand" href="/" aria-label="SolCut home">
          <span className="landing-brand__mark" aria-hidden="true">S</span>
          <span>SolCut</span>
        </a>
        <nav aria-label="Main navigation">
          <a href="#features">What it does</a>
          <a href="#workflow">How it works</a>
          <a href="#proof">Why SolCut</a>
        </nav>
        <div className="landing-nav__actions">
          <a className="landing-link" href="/login">Log in</a>
          <a className="landing-button landing-button--small" href="/sign-up">Get started</a>
        </div>
      </header>

      <main>
        <section className="landing-hero" aria-labelledby="hero-title">
          <div className="landing-hero__copy">
            <p className="landing-kicker">A calmer way to cut</p>
            <h1 id="hero-title">Make the moment<br /><em>move.</em></h1>
            <p className="landing-hero__lede">SolCut turns your raw footage into a film with a point of view.</p>
            <div className="landing-hero__actions">
              <a className="landing-button landing-button--primary" href="/sign-up">Get started</a>
              <a className="landing-button landing-button--quiet" href="/editor">Open the editor <span aria-hidden="true">↗</span></a>
            </div>
          </div>
          <figure className="landing-hero__visual">
            <img src={heroImage} alt="A silver editing dial and translucent film frames in violet studio light" />
            <figcaption><span>SolCut / one timeline</span><span>For the in-between</span></figcaption>
          </figure>
        </section>

        <section className="landing-signal" aria-label="Product promise">
          <p>Editing should feel like finding the shape of a story, not fighting the software.</p>
          <span className="landing-signal__line" aria-hidden="true" />
          <p className="landing-signal__aside">Photos, video, and sound. One place.</p>
        </section>

        <section className="landing-features" id="features" aria-labelledby="features-title">
          <div className="landing-section-heading">
            <h2 id="features-title">Everything you need<br /><span>to find the cut.</span></h2>
            <p>SolCut keeps the technical work close at hand and the creative decision in front of you.</p>
          </div>
          <div className="landing-feature-list">
            {features.map((feature) => (
              <article className="landing-feature" key={feature.number}>
                <span className="landing-feature__number">{feature.number}</span>
                <h3>{feature.title}</h3>
                <p>{feature.copy}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="landing-workflow" id="workflow" aria-labelledby="workflow-title">
          <div className="landing-workflow__intro">
            <h2 id="workflow-title">From first frame<br />to final feeling.</h2>
            <p>Start loose. Shape the sequence. Let the transitions do their quiet work.</p>
          </div>
          <div className="landing-workflow__steps">
            <div><strong>Bring it in</strong><span>Drop in your media.</span></div>
            <div><strong>Find the rhythm</strong><span>Arrange one clear timeline.</span></div>
            <div><strong>Make it yours</strong><span>Generate, tune, and export.</span></div>
          </div>
        </section>

        <section className="landing-proof" id="proof" aria-labelledby="proof-title">
          <div className="landing-proof__mark" aria-hidden="true">“</div>
          <div>
            <h2 id="proof-title">The tool should disappear.<br />The story should stay.</h2>
            <p>SolCut is built for the edit that starts as a folder of fragments and ends somewhere you did not expect.</p>
          </div>
        </section>

        <section className="landing-final" aria-labelledby="final-title">
          <p className="landing-kicker">Your next cut starts here</p>
          <h2 id="final-title">Give the in-between<br /><em>a little more life.</em></h2>
          <a className="landing-button landing-button--primary" href="/sign-up">Get started</a>
        </section>
      </main>

      <footer className="landing-footer">
        <a className="landing-brand" href="/" aria-label="SolCut home">
          <span className="landing-brand__mark" aria-hidden="true">S</span>
          <span>SolCut</span>
        </a>
        <p>Make something that moves.</p>
        <div><a href="/login">Log in</a><a href="/sign-up">Get started</a></div>
      </footer>
    </div>
  );
}
