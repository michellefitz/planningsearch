# Architectural Conservation Areas (ACA) — data sources & refresh

The map's "Architectural Conservation Areas" layer is a **static file baked
into the frontend** (`web/public/aca.geojson`, ~570 KB, 122 areas), merged
from the five councils' development-plan data. It is deliberately not fetched
live: ACA boundaries change once per development-plan cycle (~6 years), and
Irish government GIS endpoints have a habit of dying (the OPW flood service
and `webservices.npws.ie` both went dark under us in July 2026).

ACAs are designated under Section 10(2)(g) / Part IV of the Planning and
Development Act 2000 — protected streetscapes, village cores and areas of
special character. They are a different thing from the NPWS Natura 2000
sites (SAC layer) and from the Record of Protected Structures.

## Where each council's data comes from (researched 2026-07-26)

| Council | Plan | Access | Source |
| --- | --- | --- | --- |
| Dublin City | 2022–2028* | Live WFS (GeoServer), layer `sd:ACA_2157`, native ITM but reprojects via `srsName` | `https://data.smartdublin.ie/geoserver/ows?service=WFS&version=2.0.0&request=GetFeature&typeNames=sd:ACA_2157&outputFormat=application/json&srsName=EPSG:4326` |
| Fingal | 2023–2029 | Live ArcGIS FeatureServer | `https://services5.arcgis.com/CI1e5PKQXvJgmJK8/arcgis/rest/services/FCC_Development_Plan_2023_2029_ACA_Architectural_Conservation_Areas/FeatureServer/0` |
| South Dublin | 2022–2028 | Live ArcGIS FeatureServer | `https://services1.arcgis.com/PxbTDTskGHCe4sv6/arcgis/rest/services/Architectural_Conservation_Areas_South_Dublin_County_Development_Plan_2022_to_2028/FeatureServer/0` |
| Dún Laoghaire-Rathdown | 2022–2028 | Static GeoJSON download (29 ACAs + 8 candidate ACAs) | `https://data.smartdublin.ie/dataset/development-plan-2022-2028-existing-conservation-areas-dlr` |
| Kildare | 2023–2029 | Static shapefile download (ITM / EPSG:2157) | `https://data.gov.ie/dataset/kildare-architectural-conservation-areas1` (file on data.kildarecoco.ie) |

\* Caveat: the DCC GeoServer layer appears to predate the 2022 plan — North
Great George's Street (designated 2021) may be missing. Worth rechecking
against the current written plan when refreshing.

Catalogue entry points if a URL above dies: [data.gov.ie](https://data.gov.ie)
(search "architectural conservation areas" + council), [data.smartdublin.ie](https://data.smartdublin.ie)
for the four Dublin authorities, [data.kildarecoco.ie](https://data.kildarecoco.ie)
for Kildare. Wicklow also has a live FeatureServer
(`services.arcgis.com/hQOfkHGHCu8mgDpG/.../Architectural_Conservation_Areas_CDP_2022_2028`)
for whenever PlanView expands.

There is **no national ACA dataset** — every council publishes its own, in
its own schema. Field names per source (as of 2026-07): DCC `ACA`/`Apas_code`;
Fingal `Obj_Desc`/`Location`; SDCC `LOCATION`/`REF`; DLR
`DESCRIPTION`/`CONSERVATION_TYPE`; Kildare `Location`.

## How to refresh

1. Make a working directory and download the five sources into it:

   ```bash
   # ArcGIS layers straight to WGS84 GeoJSON
   curl -s "<FINGAL FeatureServer>/query?where=1%3D1&outFields=*&outSR=4326&geometryPrecision=6&f=geojson" -o fingal.geojson
   curl -s "<SDCC FeatureServer>/query?where=1%3D1&outFields=*&outSR=4326&geometryPrecision=6&f=geojson" -o sdcc.geojson
   # DCC via WFS (already includes srsName=EPSG:4326 in the URL above)
   curl -s "<DCC WFS URL>" -o dcc.geojson
   # DLR static GeoJSON, Kildare shapefile zip (unzip to ./kildare/)
   ```

2. Run the merge script from that directory (pure Python 3, no deps — it
   contains its own shapefile reader and ITM→WGS84 conversion):

   ```bash
   python3 scripts/aca/merge_aca.py
   ```

   It normalises every source to `{aca_name, council, council_label, ref,
   designation}`, rounds coordinates to 6 dp, converts Kildare from ITM, and
   writes `aca.geojson`. It prints per-council counts — expect roughly
   DCC 23, Fingal 33, SDCC 18, DLR 37, Kildare 11.

3. Copy the output over `web/public/aca.geojson`, spot-check on the map
   (Layers → Architectural Conservation Areas; Capel Street, Tallaght
   Village, Athy and Dalkey are good sanity pins), commit.

The frontend loads the file once when the layer is first toggled on
(`MapView.tsx`, the `aca` branch of `applyOverlay`) — there is no backend
component to this layer.
