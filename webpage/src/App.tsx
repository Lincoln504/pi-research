import type { Component } from 'solid-js';
import WavyTextBackground from './WavyTextBackground';

const App: Component = () => {
  return (
    <>
      <WavyTextBackground />
      <div class="box">
        <div class="dictionary-header">P • Research</div>
        <div class="dictionary-word">pretext</div>
        <div class="dictionary-pronunciation">/ˈpriːtɛkst/</div>
        <div class="dictionary-definition">
          <strong>1.</strong> a reason given in justification of a course of action that is not the real reason. 
          <br/><br/>
          <strong>2.</strong> (in web engineering) a high-performance text measurement and layout library used to solve the "layout reflow" bottleneck.
        </div>
      </div>
    </>
  );
};

export default App;
