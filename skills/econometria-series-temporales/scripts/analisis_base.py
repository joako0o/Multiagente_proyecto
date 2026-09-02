#!/usr/bin/env python3
"""
Plantilla mínima: pruebas de estacionariedad (ADF + KPSS) para cada columna de un CSV
indexado por fecha, con resumen en Markdown.

    python analisis_base.py datos.csv --fecha fecha --log precio_a precio_b

Requiere: pandas, statsmodels.
"""
import argparse
import sys

import numpy as np
import pandas as pd


def pruebas_estacionariedad(serie: pd.Series) -> dict:
    from statsmodels.tsa.stattools import adfuller, kpss

    serie = serie.dropna()
    adf_stat, adf_p, *_ = adfuller(serie, autolag="AIC")
    kpss_stat, kpss_p, *_ = kpss(serie, regression="c", nlags="auto")
    if adf_p < 0.05 and kpss_p >= 0.05:
        conclusion = "estacionaria"
    elif adf_p >= 0.05 and kpss_p < 0.05:
        conclusion = "raíz unitaria (I(1))"
    else:
        conclusion = "no concluyente: revisar quiebres o tendencia"
    return {"adf_stat": adf_stat, "adf_p": adf_p, "kpss_stat": kpss_stat, "kpss_p": kpss_p, "conclusion": conclusion}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("csv")
    parser.add_argument("--fecha", default="fecha", help="columna de fecha")
    parser.add_argument("--log", nargs="*", default=[], help="columnas a las que aplicar logaritmo")
    args = parser.parse_args()

    df = pd.read_csv(args.csv, parse_dates=[args.fecha]).set_index(args.fecha).sort_index()
    for col in args.log:
        df[col] = np.log(df[col].where(df[col] > 0))

    print("| Serie | ADF (p) | KPSS (p) | Conclusión |")
    print("|---|---|---|---|")
    for col in df.select_dtypes("number").columns:
        r = pruebas_estacionariedad(df[col])
        print(f"| {col} | {r['adf_stat']:.3f} ({r['adf_p']:.3f}) | {r['kpss_stat']:.3f} ({r['kpss_p']:.3f}) | {r['conclusion']} |")
    return 0


if __name__ == "__main__":
    sys.exit(main())
