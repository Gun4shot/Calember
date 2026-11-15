export function AboutPage() {
  return (
    <main className="page about" id="main">
      <header className="page-head">
        <p className="kicker">About</p>
        <h1>Calember: the fire memory that outlives its satellites</h1>
        <p className="lede">
          NASA's Terra and Aqua MODIS sensors counted active fires for a quarter of a century and are ending their mission. Their successors, the VIIRS sensors, see
          more and smaller fires, so their counts cannot be compared with MODIS directly. Calember translates every VIIRS month into the number MODIS would have reported, and
          tests that translation openly.
        </p>
      </header>
      <section className="lab-sec">
        <h2>What the numbers mean</h2>
        <p>
          <strong>Hotspots (MODIS-equivalent)</strong>: the number of active-fire detections NASA FIRMS MODIS Collection 6.1 (Terra + Aqua, confidence ≥ 30, vegetation
          fires only) would have reported at its original overpass times, with complete data on every day. Persistent industrial heat sources such as gas flares are masked.
          A hotspot is a detection, not a fire: one large fire can produce many.
        </p>
        <ul className="limits">
          <li>2000–2002: Terra only, scaled to Terra + Aqua.</li>
          <li>2002–2011: MODIS as observed, with satellite data gaps filled.</li>
          <li>2012–2019: MODIS blended with the VIIRS translation.</li>
          <li>2020 on: the VIIRS translation (S-NPP, NOAA-20 when S-NPP lost data). From August 2026: NOAA-20 near-real-time, provisional.</li>
        </ul>
      </section>
      <section className="lab-sec">
        <h2>Data and credits</h2>
        <ul className="limits">
          <li>
            Fire detections: NASA FIRMS, MODIS C6.1 (MCD14ML) and VIIRS 375 m (VNP14IMGML, VJ114IMGML, VJ214IMGML). We acknowledge the use of data and imagery from LANCE
            FIRMS operated by NASA's Earth Science Data and Information System (ESDIS).
          </li>
          <li>Boundaries and place names: Natural Earth (public domain).</li>
          <li>Biomes: RESOLVE Ecoregions 2017 (CC-BY 4.0).</li>
          <li>Night-lights imagery in the story film: NASA Earth Observatory, Black Marble.</li>
        </ul>
      </section>
      <section className="lab-sec">
        <h2>How it was made</h2>
        <p>
          Built by team Calember for the NASA Space Apps Challenge 2026 (“Harmonization of MODIS and VIIRS Hot Spots”). The software was written with the help of AI coding
          assistants directed by the team; every number in the app comes from the data files and the published validation report. No personal data is collected; the
          Turing-test page keeps only an anonymous right/wrong tally in memory.
        </p>
      </section>
    </main>
  );
}
