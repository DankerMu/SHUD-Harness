#!/usr/bin/env Rscript
# Local-only oracle generator: R 4.5.0, rSHUD 2.5.0, xts 0.14.1.
# Run from the repository root after materializing the canonical test dataset:
# Rscript scripts/metrics/rshud-crosscheck.R --run-root packages/dsh-shud-records/test/fixtures/wb-mini --project wbmini --output-json packages/dsh-shud-records/test/fixtures/wb-mini/expected-rshud.json
# The same CLI accepts a real run copy, its project, and a local evidence JSON path.
# Source: rSHUD/R/WaterBalance.R wb.all and wb.DS. No TS calculations are imported.
# Never invoked by tests, CI, runtime packages, or installation. Once generated,
# expectation bytes are frozen; tests and formatters must not regenerate them.

require_condition <- function(ok, message) {
  if (!isTRUE(ok)) stop(message, call. = FALSE)
}

# Shortest round-trip decimal, using JSON/JavaScript's fixed/exponent thresholds.
# This avoids formatter changes to long binary-roundoff tails from %.17g.
json_number <- function(value) {
  if (value == 0) return("0")
  for (digits in 1:17) {
    text <- sprintf("%.*g", digits, value)
    if (identical(as.numeric(text), value)) break
  }
  if (abs(value) >= 1e-6 && abs(value) < 1e21) {
    places <- max(0, digits - 1 - floor(log10(abs(value))))
    text <- sprintf("%.*f", places, value)
  } else {
    text <- sub("e([+-])0+", "e\\1", text)
  }
  text
}

main <- function(args) {
  options(OutDec = ".")
  require_condition(as.character(getRversion()) == "4.5.0", "Requires R 4.5.0")
  versions <- c(rSHUD = "2.5.0", xts = "0.14.1")
  for (package in names(versions)) {
    require_condition(requireNamespace(package, quietly = TRUE),
                      paste("Missing local prerequisite:", package, versions[[package]]))
    require_condition(as.character(utils::packageVersion(package)) == versions[[package]],
                      paste("Requires", package, versions[[package]]))
  }

  require_condition(length(args) %% 2 == 0,
                    "Usage: --run-root DIR --project NAME --output-json FILE")
  options_cli <- list("--run-root" = "packages/dsh-shud-records/test/fixtures/wb-mini",
                      "--project" = "wbmini", "--output-json" = NULL)
  if (length(args) > 0) {
    keys <- args[seq.int(1, length(args), 2)]
    require_condition(!anyDuplicated(keys) && all(keys %in% names(options_cli)),
                      "Unknown or repeated CLI option")
    for (i in seq.int(1, length(args), 2)) options_cli[[args[i]]] <- args[i + 1]
  }
  root <- normalizePath(options_cli[["--run-root"]], mustWork = TRUE)
  project <- options_cli[["--project"]]
  require_condition(grepl("^[A-Za-z0-9][A-Za-z0-9_-]*$", project),
                    "Project must be a single SHUD project name")
  input <- file.path(root, "input", project)
  output <- file.path(root, "output", paste0(project, ".out"))
  require_condition(dir.exists(input) && dir.exists(output),
                    "Run input and output directories must already exist")
  destination <- options_cli[["--output-json"]]
  if (is.null(destination)) destination <- file.path(root, "expected-rshud.json")
  require_condition(dir.exists(dirname(destination)), "Output JSON parent directory must exist")
  require_condition(!file.exists(destination), "Output JSON already exists; frozen oracles are not overwritten")

  variables <- c("elevprcp", "eleveta", "elevetp", "eleysurf", "eleyunsat",
                 "eleygw", "rivystage", "rivqdown")
  inputs <- c("sp.mesh", "sp.att", "sp.riv", "para.geol", "cfg.para", "cfg.calib", "cfg.ic")
  required_files <- c(file.path(input, paste0(project, ".", inputs)),
                      file.path(output, paste0(project, ".", variables, ".dat")))
  for (path in required_files) {
    require_condition(file.exists(path) && !dir.exists(path) && file.access(path, 4) == 0,
                      paste("Missing or unreadable prerequisite:", path))
  }

  analysis <- tempfile("rshud-crosscheck-")
  on.exit(unlink(analysis, recursive = TRUE), add = TRUE)
  rSHUD::shud.env(project, inpath = input, outpath = output, anapath = analysis, version = 2)
  area <- rSHUD::getArea()
  river <- rSHUD::read_river()
  ic <- rSHUD::read_ic()
  att <- rSHUD::read_att()
  geol <- rSHUD::read_geol()
  calib <- rSHUD::read_calib()
  ne <- length(area)
  nr <- nrow(river@river)
  require_condition(ne > 0 && all(is.finite(area)) && all(area > 0) && is.finite(sum(area)),
                    "Reference requires finite positive element areas")
  require_condition(nr > 0 && length(rSHUD::getOutlets(river)) == 1,
                    "Reference requires exactly one river outlet")
  require_condition(nrow(ic$minit) == ne && nrow(ic$rinit) == nr && nrow(att) == ne,
                    "Reference IC and attribute shapes must cover the entire domain")
  require_condition(sum(names(calib) == "GEOL_THETAS") == 1 &&
                    length(calib$GEOL_THETAS) == 1 && is.finite(calib$GEOL_THETAS),
                    "Reference requires one finite GEOL_THETAS")
  require_condition(length(geol$ThetaS.m3_m3.) == nrow(geol) &&
                    all(is.finite(geol$ThetaS.m3_m3.)),
                    "Reference geology must contain finite ThetaS(m3_m3)")
  require_condition(all(att$GEOL %in% seq_len(nrow(geol))) &&
                    all(river@river$Type %in% seq_len(nrow(river@rivertype))),
                    "Reference geology and river types must be valid one-based row references")

  # Explicitly include stage and actual PET; wb.all's default list omits stage.
  xl <- rSHUD::loaddata(varname = variables)
  times <- NULL
  for (variable in variables) {
    series <- xl[[variable]]
    columns <- if (startsWith(variable, "riv")) nr else ne
    require_condition(ncol(series) == columns &&
                      identical(colnames(series), as.character(seq_len(columns))),
                      paste(variable, "requires complete ascending column IDs"))
    require_condition(nrow(series) >= 2 && all(is.finite(series)),
                      paste(variable, "requires at least two finite daily observations"))
    observed_times <- as.numeric(stats::time(series))
    require_condition(all(is.finite(observed_times)) && all(diff(observed_times) == 86400),
                      paste(variable, "requires exactly 1440-minute spacing"))
    if (is.null(times)) times <- observed_times
    require_condition(identical(times, observed_times), "All reference series must share the time grid")
  }

  aggregate_run <- function(x, FUN) matrix(FUN(x), 1L, 1L)
  balance <- rSHUD::wb.all(xl = xl, ic = ic, fun = aggregate_run, plot = FALSE)
  storage <- rSHUD::wb.DS(xl = xl, ic = ic)
  require_condition(identical(dim(balance), c(1L, 5L)) && all(is.finite(balance)),
                    "wb.all returned an invalid whole-run balance")
  require_condition(identical(dim(storage$Ele), c(3L, as.integer(ne))) &&
                    identical(rownames(storage$Ele), c("ds.sf", "ds.us", "ds.gw")) &&
                    length(storage$Riv) == nr && all(is.finite(storage$Ele)) &&
                    all(is.finite(storage$Riv)), "wb.DS returned invalid storage components")
  # wb.all returns P/Q/AET but only prints its area-weighted storage summary.
  # Apply that same return-value reduction to the per-element wb.DS components;
  # its river components are already divided by catchment area.
  weights <- area / sum(area)
  values <- c(P = unname(balance[1, "P"]), Qd = unname(balance[1, "Q"]),
              AET = unname(balance[1, "AET"]),
              delta_s_surf = sum(storage$Ele["ds.sf", ] * weights),
              delta_s_us = sum(storage$Ele["ds.us", ] * weights),
              delta_s_gw = sum(storage$Ele["ds.gw", ] * weights),
              delta_s_riv = sum(storage$Riv))
  require_condition(length(values) == 7 && all(is.finite(values)),
                    "Cannot freeze nonfinite or incomplete reference terms")
  lines <- paste0('  "', names(values), '": ', vapply(values, json_number, character(1)),
                  c(rep(",", 6), ""))
  writeLines(c("{", lines, "}"), destination, useBytes = TRUE)
}

main(commandArgs(trailingOnly = TRUE))
