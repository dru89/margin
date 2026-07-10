export function Welcome() {
  return (
    <div className="welcome">
      <div className="welcome-card">
        <h1 className="welcome-title">Margin</h1>
        <p className="welcome-tagline">
          Write in markdown. Comment in the margin.
          <br />
          Claude reviews in rounds — you decide what lands.
        </p>
        <button className="btn btn-primary btn-lg" onClick={() => void window.margin.openFileDialog()}>
          Open a markdown file…
        </button>
        <p className="welcome-hint">
          <kbd>⌘O</kbd> / <kbd>Ctrl+O</kbd> to open · recent files live in the File menu
        </p>
      </div>
    </div>
  );
}
