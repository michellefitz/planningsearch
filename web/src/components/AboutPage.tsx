export function AboutPage({ onGetStarted }: { onGetStarted: () => void }) {
  return (
    <div className="about-page">
      <div className="about-content">
        <h2>One search across Ireland's planning registers</h2>
        <p>
          PlanView pulls together planning applications from councils across Ireland into a single
          searchable map. Instead of checking each council's website separately, you can search by
          address, area, or keyword and see everything that's been lodged, granted, or refused nearby.
        </p>

        <h3>What you can see</h3>
        <ul>
          <li>
            <strong>Every application on the map.</strong> Browse planning applications across Dublin
            City, Fingal, Dun Laoghaire-Rathdown, South Dublin, Kildare, Cork City, Cork County,
            Wexford, Meath, and Wicklow. More councils are being added.
          </li>
          <li>
            <strong>The full picture for each property.</strong> Application details, decision
            status, timelines, related applications at the same address, conditions, refusal reasons,
            and AI-generated plain-English summaries of what's actually being proposed.
          </li>
          <li>
            <strong>Documents on file.</strong> Where available, the scanned plans, drawings,
            and correspondence submitted with each application.
          </li>
          <li>
            <strong>Context layers.</strong> Zoning, residential zoned land tax, flood risk data,
            and derelict sites overlaid on the map so you can see what applies to a location.
          </li>
          <li>
            <strong>An AI planning assistant.</strong> Ask questions about what's happening in an
            area, what the rules are, or what a particular application means. It searches the
            register and answers in plain language.
          </li>
        </ul>

        <h3>Create an account</h3>
        <p>
          Signing up is free and takes a few seconds. With an account you can:
        </p>
        <ul>
          <li>Save applications and come back to them later</li>
          <li>Get email alerts when a saved application is updated</li>
          <li>Watch an area on the map and get notified when new applications are lodged nearby</li>
          <li>Generate a property report that pulls together everything we know about a site</li>
        </ul>

        <div className="about-cta">
          <button type="button" className="btn btn-primary" onClick={onGetStarted}>
            Get started
          </button>
          <span className="about-cta-note">No credit card required</span>
        </div>

        <h3>Where does the data come from?</h3>
        <p>
          Planning application data comes from the National Planning Applications dataset published
          by the Department of Housing. We supplement it with data directly from each council's
          planning portal to fill gaps and get fuller descriptions, applicant details, and documents.
          The data refreshes nightly.
        </p>
        <p>
          Zoning data comes from the National Generalised Zoning Types layer. Flood risk data is
          sourced from OPW CFRAM studies. All data is used under its published licence terms.
        </p>

        <p className="about-footer">
          PlanView is built by <a href="https://sideforge.dev">Sideforge</a>. If you have
          questions or feedback, get in touch at{" "}
          <a href="mailto:michelle@sideforge.dev">michelle@sideforge.dev</a>.
        </p>
      </div>
    </div>
  );
}
