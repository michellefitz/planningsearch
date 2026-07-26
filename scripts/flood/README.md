# Flood Zone Data

Source: OPW (Office of Public Works) national indicative flood mapping.

## Datasets

- **NIFM** (National Indicative Fluvial Mapping): river flood extents, current scenario
  - URL: https://s3.eu-west-1.amazonaws.com/catalogue.floodinfo.opw/nifm/nifm_ext_f_c.zip
  - Dataset page: https://data.gov.ie/dataset/nifm-river-flood-extents-current-scenario
  - Licence: Creative Commons Attribution-NonCommercial-NoDerivatives 4.0
- **NCFHM** (National Coastal Flood Hazard Mapping): coastal flood extents, current scenario
  - URL: https://s3.eu-west-1.amazonaws.com/catalogue.floodinfo.opw/ncfhm_itm_ext_c_c_1000yr_200yr_10yr.zip
  - Dataset page: https://data.gov.ie/dataset/national-coastal-flood-extents-2021-current-scenario
  - Licence: Creative Commons Attribution-NonCommercial-NoDerivatives 4.0

Note: the task brief refers to coastal data as "NICM" but OPW publishes it as "NCFHM".

## CRS

Both datasets use Irish Transverse Mercator (ITM, EPSG:2157). The build script must reproject to WGS84 (EPSG:4326) for web display.

## File structure

Each dataset contains separate shapefiles per return period (AEP is encoded in the filename):

**NIFM (fluvial):**
- `nifm_ext_f_c_0020.shp` — 1-in-20 year (5% AEP)
- `nifm_ext_f_c_0100.shp` — 1-in-100 year (1% AEP)
- `nifm_ext_f_c_1000.shp` — 1-in-1000 year (0.1% AEP)

**NCFHM (coastal):**
- `ncfhm_itm_ext_c_c_0010.shp` — 1-in-10 year (10% AEP)
- `ncfhm_itm_ext_c_c_0200.shp` — 1-in-200 year (0.5% AEP)
- `ncfhm_itm_ext_c_c_1000.shp` — 1-in-1000 year (0.1% AEP)

## Attribute schema

Both datasets share a common OPW attribution scheme. Key fields:

| Field   | Description           | NIFM example | NCFHM example |
|---------|-----------------------|--------------|---------------|
| dm_uuid | Data model UUID       | uuid         | uuid          |
| ext_id  | Extent feature UUID   | uuid         | uuid          |
| mc/sch  | Model/scheme code     | `06` (mc)    | `000` (sch)   |
| ttt     | Data type             | `ext`        | `ext`         |
| s       | Source type           | `f` (fluvial)| `c` (coastal) |
| c       | Scenario              | `c` (current)| `c` (current) |
| r       | Run type              | `d` (design) | `d` (design)  |
| pppp    | Return period (years) | `0020`       | `0010`        |
| a       | Status                | `f` (final)  | `f` (final)   |
| rn      | Revision number       | `01`         | `00`          |
| comments| Free text             |              |               |

NIFM uses `mc` (model code, 2-digit); NCFHM uses `sch` (scheme code, 3-digit). Otherwise the schemas are the same.

## Pipeline

1. `./download.sh` — fetches raw shapefiles to `data/`
2. `node build.mjs` — converts, simplifies, merges into web-ready GeoJSON
