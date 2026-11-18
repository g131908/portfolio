export const ABOUT_HTML = `
<div class="about">
  <section class="card">
    <h2>What this tool can and cannot tell you</h2>
    <p>No software can prove that a picture shows the truth. What it can do is collect evidence: things the file says
      about itself, traces that editing leaves behind, and cryptographic signatures that cannot be faked. Every finding
      is shown with its reason, and the overall assessment never claims more than the evidence supports.</p>
  </section>
  <div class="about-grid">
    <section class="card"><h3>🛡️ Disguised and dangerous files</h3>
      <ul>
        <li>Real file type from the content ("magic bytes"), compared with name and declared type</li>
        <li>Double extensions (<code>invoice.pdf.exe</code>) and right-to-left override tricks</li>
        <li>Word/Excel: macros, remote template injection, DDE fields, embedded objects</li>
        <li>PDF: JavaScript, auto-actions, launch actions, hidden attachments, data-sending forms</li>
        <li>Files hidden after the end of an image (polyglots)</li>
      </ul></section>
    <section class="card"><h3>🔏 Content credentials (C2PA)</h3>
      <ul>
        <li>Reads and cryptographically verifies C2PA manifests with the official SDK (Rust → WebAssembly)</li>
        <li>Checks the signer against the official C2PA trust list</li>
        <li>Detects pixels changed after signing and altered credentials</li>
        <li>Shows the recorded editing history and declared AI generation</li>
      </ul></section>
    <section class="card"><h3>🔬 Image forensics</h3>
      <ul>
        <li>Error Level Analysis heatmap with automatic hotspot detection</li>
        <li>JPEG quantization tables: quality estimate and software fingerprint</li>
        <li>Embedded camera thumbnail compared with the visible image</li>
        <li>Comparison with an original using perceptual hashes and a difference map</li>
      </ul></section>
    <section class="card"><h3>🏷️ Metadata</h3>
      <ul>
        <li>Camera, lens, capture time, GPS location (EXIF, XMP, IPTC)</li>
        <li>Editing software and XMP editing history</li>
        <li>Markers of AI generators, IPTC "trained algorithmic media", Stable Diffusion prompts in PNG files</li>
        <li>Impossible or suspicious dates</li>
      </ul></section>
  </div>
  <section class="card">
    <h3>Privacy</h3>
    <p>All analysis runs in this browser tab (Web Worker and WebAssembly). Files are never uploaded. The only network
      requests are the app itself, the C2PA verifier and the public C2PA trust list.</p>
  </section>
</div>`;
