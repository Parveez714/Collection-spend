import os
import io
import time
import json
import logging
from typing import Dict, List, Optional, Any
import requests
import pandas as pd
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

MONTHS_ORDER = {'Jan': 1, 'Feb': 2, 'Mar': 3, 'Apr': 4, 'May': 5, 'Jun': 6,
                'Jul': 7, 'Aug': 8, 'Sep': 9, 'Oct': 10, 'Nov': 11, 'Dec': 12}
MONTHS_INV = {v: k for k, v in MONTHS_ORDER.items()}

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("expense-agent")

# Load environment variables strictly from .env
load_dotenv(dotenv_path=".env", override=True)
if not os.getenv("API_1_URL"):
    load_dotenv(dotenv_path="../.env", override=True)

app = FastAPI(title="Expense Agent - Financial Projections & Heatmap API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global caches
_cached_df1: Optional[pd.DataFrame] = None
_cached_df_ps: Optional[pd.DataFrame] = None
_cached_df_spend: Optional[pd.DataFrame] = None
_cached_master_projects: Optional[List[str]] = None
_cached_token: Optional[str] = None
_token_expiry: float = 0.0

def get_auth_token(force_refresh: bool = False) -> str:
    """Fetch authentication token strictly using .env configuration."""
    global _cached_token, _token_expiry
    now = time.time()
    if not force_refresh and _cached_token and now < (_token_expiry - 120):
        return _cached_token

    auth_url = os.getenv("AUTH_URL", "").strip()
    username = os.getenv("AUTH_USERNAME", "").strip()
    password = os.getenv("AUTH_PASSWORD", "").strip()
    token_seed = os.getenv("AUTH_TOKEN", "").strip()

    if not auth_url:
        raise HTTPException(status_code=500, detail="AUTH_URL not configured in .env")

    headers = {
        "accept": "text/plain",
        "Content-Type": "application/json",
        "username": username,
        "password": password
    }
    payload = {
        "type": "E",
        "token": token_seed,
        "username": username,
        "password": password
    }

    try:
        resp = requests.post(auth_url, headers=headers, json=payload, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        token = data.get("data", {}).get("token")
        if not token:
            raise ValueError("Token not returned in auth response")
        _cached_token = token
        _token_expiry = now + 43200
        return _cached_token
    except Exception as e:
        logger.error(f"Failed to obtain auth token: {e}")
        raise HTTPException(status_code=502, detail=f"Authentication failed: {str(e)}")

def json_to_df(json_data: Any) -> pd.DataFrame:
    """Convert API JSON response to pandas DataFrame."""
    if isinstance(json_data, dict):
        if "data" in json_data and isinstance(json_data["data"], dict):
            inner = json_data["data"]
            if "reportData" in inner and isinstance(inner["reportData"], list):
                rd = inner["reportData"]
                if len(rd) > 0 and isinstance(rd[0], list):
                    return pd.DataFrame(rd[0])
                return pd.DataFrame(rd)
            for k, v in inner.items():
                if isinstance(v, list) and len(v) > 0:
                    return pd.DataFrame(v[0] if isinstance(v[0], list) else v)
        for k, v in json_data.items():
            if isinstance(v, list) and len(v) > 0:
                return pd.DataFrame(v[0] if isinstance(v[0], list) else v)
        return pd.json_normalize(json_data)
    elif isinstance(json_data, list):
        return pd.DataFrame(json_data[0] if (len(json_data) > 0 and isinstance(json_data[0], list)) else json_data)
    return pd.json_normalize(json_data)

def fetch_api_dataset(url_key: str, method_key: str, payload_key: str, header_key_name: str = "API_1_HEADER_KEY") -> pd.DataFrame:
    url = os.getenv(url_key, "").strip()
    if not url:
        raise HTTPException(status_code=500, detail=f"Environment variable '{url_key}' is not set in .env")

    method = os.getenv(method_key, "POST").strip().upper()
    header_header = os.getenv(header_key_name, "Authorization").strip() or "Authorization"
    token = get_auth_token()
    payload_raw = os.getenv(payload_key, "").strip()

    headers = {
        "accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        header_header: token
    }

    kwargs = {"headers": headers, "timeout": 35}
    if payload_raw:
        try:
            kwargs["json"] = json.loads(payload_raw)
        except Exception:
            kwargs["data"] = payload_raw

    try:
        response = requests.request(method=method, url=url, **kwargs)
        response.raise_for_status()
    except requests.RequestException as e:
        logger.error(f"API request failed for {url_key}: {e}")
        raise HTTPException(status_code=502, detail=f"Failed to fetch data from {url_key}: {str(e)}")

    try:
        return json_to_df(response.json())
    except Exception:
        return pd.read_csv(io.StringIO(response.text))

def fetch_data1() -> pd.DataFrame:
    global _cached_df1
    if _cached_df1 is not None:
        return _cached_df1
    df = fetch_api_dataset("API_1_URL", "API_1_METHOD", "API_1_PAYLOAD", "API_1_HEADER_KEY")
    if df is None or df.empty:
        raise HTTPException(status_code=502, detail="API 1 returned empty dataset")
    _cached_df1 = df
    return _cached_df1

def fetch_data_payment_schedule() -> pd.DataFrame:
    global _cached_df_ps
    if _cached_df_ps is not None:
        return _cached_df_ps
    df = fetch_api_dataset("API_PS_URL", "API_PS_METHOD", "API_PS_PAYLOAD", "API_PS_HEADER_KEY")
    if df is None or df.empty:
        raise HTTPException(status_code=502, detail="API PS returned empty dataset")
    _cached_df_ps = df
    return _cached_df_ps

def _get_excel_path() -> str:
    path = os.getenv("SPEND_EXCEL_PATH", "Spend data.xlsx").strip()
    if not os.path.isabs(path):
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", path)
    return os.path.normpath(path)

def load_spend_data() -> Optional[pd.DataFrame]:
    """One-time ingestion of historical construction spend from Excel (Spend data.xlsx).
    Sheet 1 'Data': SAP line items.  Sheet 2 'Project names': code → name mapping."""
    global _cached_df_spend, _cached_master_projects
    if _cached_df_spend is not None:
        return _cached_df_spend

    path = _get_excel_path()
    if not os.path.exists(path):
        logger.warning(f"Spend Excel not found at: {path}")
        return None

    try:
        # Build project-code → project-name lookup and master project list from sheet 2
        df_proj = pd.read_excel(path, sheet_name="Project names", header=0)
        code_to_name: dict = {}
        master: List[str] = []
        for _, row in df_proj.iterrows():
            name = str(row.iloc[0]).strip()
            if name and name.lower() not in ("project name", "nan", ""):
                clean = normalize_project_name(name)
                if clean not in master:
                    master.append(clean)
            for col_idx in range(1, len(row)):
                code = str(row.iloc[col_idx]).strip()
                if code and code.lower() not in ("none", "nan", "not found", ""):
                    code_to_name[code] = name
        _cached_master_projects = master

        # Load line items from sheet 1
        df = pd.read_excel(path, sheet_name="Data", header=0)

        df["Project_Code"] = df["Project definition"].astype(str).str.strip()
        df["Project_Name"] = df["Project_Code"].map(code_to_name).fillna("Unknown")
        df["Project_Clean"] = df["Project_Name"].apply(normalize_project_name)
        df["Amount"] = pd.to_numeric(df["Val/COArea Crcy"], errors="coerce").fillna(0.0)
        df["Posting_Date"] = pd.to_datetime(df["Posting Date"], errors="coerce")
        df = df.dropna(subset=["Posting_Date"])
        df["Year_int"] = df["Posting_Date"].dt.year
        df["Month_Num"] = df["Posting_Date"].dt.month
        df["Month_str"] = df["Month_Num"].map(MONTHS_INV)
        df["FY"] = df.apply(lambda r: calc_fiscal_year(r["Year_int"], r["Month_str"]), axis=1)

        def _qtr(m: int) -> str:
            if m in (4, 5, 6): return "Q1"
            if m in (7, 8, 9): return "Q2"
            if m in (10, 11, 12): return "Q3"
            return "Q4"

        df["Quarter"] = df["Month_Num"].apply(_qtr) + " " + df["FY"]
        df["MonthYear"] = df["Month_str"] + "-" + df["Year_int"].astype(str).str[-2:]

        _cached_df_spend = df
        logger.info(f"Loaded spend data: {len(df)} rows, {len(master)} master projects from {path}")
        return _cached_df_spend

    except Exception as e:
        logger.error(f"Failed to load spend Excel: {e}")
        return None

def get_master_projects() -> List[str]:
    """Return canonical project list from Project names sheet (all 16 entries)."""
    global _cached_master_projects
    if _cached_master_projects is not None:
        return _cached_master_projects
    load_spend_data()  # populates _cached_master_projects as a side-effect
    return _cached_master_projects or []

def normalize_project_name(raw_name: str) -> str:
    name = str(raw_name).strip()
    name = name.replace("\u2013", "-").replace("\u2014", "-")
    if "Citadel" in name:
        return "Embassy Citadel"
    if "Vallora" in name or "Canopy" in name:
        return "Embassy Vallora / Canopy"
    if "Panvel" in name:
        return "Embassy Park, Panvel"
    return name

def calc_fiscal_year(year_val: Any, month_val: Any) -> str:
    try:
        y = int(year_val)
        m = str(month_val).strip()[:3].lower()
        if m in ["jan", "feb", "mar"]:
            return f"FY{str(y)[-2:]}"
        return f"FY{str(y + 1)[-2:]}"
    except Exception:
        return "FY26"

def get_processed_billed_schedule(df_ps: pd.DataFrame) -> pd.DataFrame:
    billed = df_ps[df_ps["Status"].astype(str).str.strip().str.lower() == "billed"].copy()
    months_order = MONTHS_ORDER
    
    billed["Year_int"] = pd.to_numeric(billed["Year"], errors="coerce")
    billed = billed.dropna(subset=["Year_int"])
    billed["Year_int"] = billed["Year_int"].astype(int)
    billed["Month_str"] = billed["Month"].astype(str).str.strip()
    billed["Month_Num"] = billed["Month_str"].map(months_order).fillna(1).astype(int)
    
    # Calculate exact Fiscal Year and Quarter
    billed["FY"] = billed.apply(lambda r: calc_fiscal_year(r["Year_int"], r["Month_str"]), axis=1)
    
    def get_qtr(m_num):
        if m_num in [4, 5, 6]: return "Q1"
        if m_num in [7, 8, 9]: return "Q2"
        if m_num in [10, 11, 12]: return "Q3"
        return "Q4"
        
    billed["Quarter"] = billed["Month_Num"].apply(get_qtr) + " " + billed["FY"]
    billed["MonthYear"] = billed["Month_str"] + "-" + billed["Year_int"].astype(str).str[-2:]
    billed["Project_Clean"] = billed["Project_Name"].apply(normalize_project_name)
    billed["Due_Num"] = pd.to_numeric(billed["Due"], errors="coerce").fillna(0.0)
    billed["Paid_Num"] = pd.to_numeric(billed["Paid"], errors="coerce").fillna(0.0)
    
    return billed

@app.get("/api/health")
def health_check():
    spend_path = os.getenv("SPEND_EXCEL_PATH", "Spend data.xlsx").strip()
    if not os.path.isabs(spend_path):
        spend_path = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", spend_path))
    return {
        "status": "ok",
        "envConfigured": {
            "API_1_URL": bool(os.getenv("API_1_URL")),
            "API_PS_URL": bool(os.getenv("API_PS_URL")),
            "SPEND_EXCEL": os.path.exists(spend_path)
        }
    }

@app.post("/api/refresh")
def refresh_cache():
    global _cached_df1, _cached_df_ps, _cached_df_spend, _cached_master_projects, _cached_token
    _cached_df1 = None
    _cached_df_ps = None
    _cached_df_spend = None
    _cached_master_projects = None
    _cached_token = None
    return {"message": "Cache successfully invalidated"}

@app.get("/api/kpis")
def get_kpis():
    df1 = fetch_data1()
    df_ps = fetch_data_payment_schedule()
    df_spend = load_spend_data()

    billed = get_processed_billed_schedule(df_ps)
    if not billed.empty:
        min_row = billed.sort_values(by=["Year_int", "Month_Num"]).iloc[0]
        max_row = billed.sort_values(by=["Year_int", "Month_Num"]).iloc[-1]
        period_label = f"{min_row['Month_str']}-{str(min_row['Year_int'])[-2:]} to {max_row['Month_str']}-{str(max_row['Year_int'])[-2:]}"
    else:
        period_label = "API Stream"

    total_sales = float(df1["TotalSalesRealization"].sum()) if "TotalSalesRealization" in df1.columns else 0.0
    sales_cr = round(total_sales / 1e7, 2)

    total_collections = float(df1["TotalReceived"].sum()) if "TotalReceived" in df1.columns else 0.0
    collections_cr = round(total_collections / 1e7, 2)

    if df_spend is not None and not df_spend.empty:
        spend_cr = round(float(df_spend["Amount"].sum()) / 1e7, 2)
    else:
        spend_cr = 0.0

    surplus_cr = round(collections_cr - spend_cr, 2)

    return {
        "periodLabel": period_label,
        "sales": {
            "label": "Sales (bookings)",
            "value": sales_cr,
            "unit": "₹ Cr",
            "formatted": f"₹{sales_cr:,.2f} Cr"
        },
        "collections": {
            "label": "Collections",
            "value": collections_cr,
            "unit": "₹ Cr",
            "formatted": f"₹{collections_cr:,.2f} Cr"
        },
        "constructionSpend": {
            "label": "Construction spend",
            "value": spend_cr,
            "unit": "₹ Cr",
            "formatted": f"₹{spend_cr:,.2f} Cr"
        },
        "projectSurplus": {
            "label": "Project surplus",
            "value": surplus_cr,
            "unit": "₹ Cr",
            "formatted": f"₹{surplus_cr:,.2f} Cr"
        }
    }

def _spend_for_period(df_spend: Optional[pd.DataFrame], col: str, val: str) -> float:
    """Return net spend (₹ Cr) for a given period column/value from the Excel spend df."""
    if df_spend is None or df_spend.empty:
        return 0.0
    sub = df_spend[df_spend[col] == val]
    return round(float(sub["Amount"].sum()) / 1e7, 2)

@app.get("/api/chart-data")
def get_chart_data(time_unit: str = Query("year", regex="^(year|quarter|month)$")):
    """
    Computes group total timeline series (Sales, Collections, Spend, Surplus).
    Sales/Collections from API payment schedule; Spend from Excel historical data.
    """
    df_ps = fetch_data_payment_schedule()
    billed = get_processed_billed_schedule(df_ps)
    df_spend = load_spend_data()

    if billed.empty:
        return {"timeUnit": time_unit, "description": "No billed records found", "series": []}

    def _fy_sort_key(x: str) -> int:
        s = x.replace("FY", "")
        return int(s) if s.isdigit() else 0

    def _union_periods(billed_col: list, spend_df: Optional[pd.DataFrame], col: str) -> list:
        """Merge periods from billed schedule and Excel spend, preserving chronological order."""
        spend_periods: list = []
        if spend_df is not None and not spend_df.empty and col in spend_df.columns:
            spend_periods = spend_df[col].dropna().unique().tolist()
        combined = sorted(set(billed_col) | set(spend_periods),
                          key=lambda x: billed_col.index(x) if x in billed_col else len(billed_col))
        return combined

    series = []
    if time_unit == "year":
        billed_fys = sorted(billed["FY"].unique(), key=_fy_sort_key)
        all_fys = _union_periods(billed_fys, df_spend, "FY")
        all_fys = sorted(all_fys, key=_fy_sort_key)
        target_fys = all_fys[-5:] if len(all_fys) >= 5 else all_fys

        for fy in target_fys:
            sub = billed[billed["FY"] == fy]
            sales = round(float(sub["Due_Num"].sum()) / 1e7, 2)
            collections = round(float(sub["Paid_Num"].sum()) / 1e7, 2)
            spend = _spend_for_period(df_spend, "FY", fy)
            series.append({"period": fy, "sales": sales, "collections": collections,
                           "spend": spend, "surplus": round(collections - spend, 2)})

    elif time_unit == "quarter":
        billed_qtrs = billed.sort_values(by=["Year_int", "Month_Num"])["Quarter"].unique().tolist()
        all_qtrs = _union_periods(billed_qtrs, df_spend, "Quarter")
        # Re-sort chronologically: parse "Q1 FY25" → (25, 1) etc.
        def _qtr_key(q: str):
            parts = q.split()
            fy_num = int(parts[1].replace("FY", "")) if len(parts) == 2 and parts[1].replace("FY","").isdigit() else 0
            q_num = int(parts[0][1]) if parts[0].startswith("Q") and parts[0][1:].isdigit() else 0
            return (fy_num, q_num)
        all_qtrs = sorted(all_qtrs, key=_qtr_key)
        target_qtrs = all_qtrs[-8:] if len(all_qtrs) >= 8 else all_qtrs

        for qtr in target_qtrs:
            sub = billed[billed["Quarter"] == qtr]
            sales = round(float(sub["Due_Num"].sum()) / 1e7, 2)
            collections = round(float(sub["Paid_Num"].sum()) / 1e7, 2)
            spend = _spend_for_period(df_spend, "Quarter", qtr)
            series.append({"period": qtr, "sales": sales, "collections": collections,
                           "spend": spend, "surplus": round(collections - spend, 2)})

    else:  # month
        billed_months = billed.sort_values(by=["Year_int", "Month_Num"])["MonthYear"].unique().tolist()
        all_months_set = _union_periods(billed_months, df_spend, "MonthYear")
        # Re-sort chronologically: "Apr-24" → (24, 4) using MONTHS_ORDER
        def _my_key(my: str):
            parts = my.split("-")
            mon = MONTHS_ORDER.get(parts[0], 0) if parts else 0
            yr = int(parts[1]) if len(parts) == 2 and parts[1].isdigit() else 0
            return (yr, mon)
        all_months_set = sorted(all_months_set, key=_my_key)
        target_months = all_months_set[-12:] if len(all_months_set) >= 12 else all_months_set

        for m in target_months:
            sub = billed[billed["MonthYear"] == m]
            sales = round(float(sub["Due_Num"].sum()) / 1e7, 2)
            collections = round(float(sub["Paid_Num"].sum()) / 1e7, 2)
            spend = _spend_for_period(df_spend, "MonthYear", m)
            series.append({"period": m, "sales": sales, "collections": collections,
                           "spend": spend, "surplus": round(collections - spend, 2)})

    return {
        "timeUnit": time_unit,
        "description": "Sales (billed demand) and collections from API; construction spend from Excel historical data. Values in ₹ Cr.",
        "series": series
    }

@app.get("/api/projects-heatmap")
def get_projects_heatmap(
    measure: str = Query("sales", regex="^(sales|collections|spend|surplus)$"),
    period_type: str = Query("year", regex="^(year|quarter|month)$")
):
    """
    Computes project-wise heatmap matrix. Sales/Collections from API; Spend from Excel.
    """
    df_ps = fetch_data_payment_schedule()
    billed = get_processed_billed_schedule(df_ps)

    df_spend = load_spend_data()

    if billed.empty and (df_spend is None or df_spend.empty):
        return {"measure": measure, "periodType": period_type, "columns": [], "rows": []}

    def _fy_key(x: str) -> int:
        s = x.replace("FY", "")
        return int(s) if s.isdigit() else 0

    def _qtr_key(q: str):
        parts = q.split()
        fy_n = int(parts[1].replace("FY", "")) if len(parts) == 2 and parts[1].replace("FY","").isdigit() else 0
        q_n = int(parts[0][1]) if parts[0].startswith("Q") and parts[0][1:].isdigit() else 0
        return (fy_n, q_n)

    def _my_key(my: str):
        parts = my.split("-")
        mon = MONTHS_ORDER.get(parts[0], 0) if parts else 0
        yr = int(parts[1]) if len(parts) == 2 and parts[1].isdigit() else 0
        return (yr, mon)

    def _spend_periods(col: str) -> list:
        if df_spend is not None and not df_spend.empty and col in df_spend.columns:
            return df_spend[col].dropna().unique().tolist()
        return []

    if period_type == "quarter":
        billed_qtrs = billed.sort_values(by=["Year_int", "Month_Num"])["Quarter"].unique().tolist() if not billed.empty else []
        all_qtrs = sorted(set(billed_qtrs) | set(_spend_periods("Quarter")), key=_qtr_key)
        period_cols = all_qtrs[-6:] if len(all_qtrs) >= 6 else all_qtrs
        group_col = "Quarter"
    elif period_type == "month":
        billed_months = billed.sort_values(by=["Year_int", "Month_Num"])["MonthYear"].unique().tolist() if not billed.empty else []
        all_months = sorted(set(billed_months) | set(_spend_periods("MonthYear")), key=_my_key)
        period_cols = all_months[-8:] if len(all_months) >= 8 else all_months
        group_col = "MonthYear"
    else:  # year
        billed_fys = list(billed["FY"].unique()) if not billed.empty else []
        all_fys = sorted(set(billed_fys) | set(_spend_periods("FY")), key=_fy_key)
        period_cols = all_fys[-4:] if len(all_fys) >= 4 else all_fys
        group_col = "FY"

    # Master project list from Excel sheet 2 (all 16 entries) + any API-only projects
    master = get_master_projects()
    billed_projects = list(billed["Project_Clean"].unique()) if not billed.empty else []
    # Preserve master order, then append any API projects not already in the master list
    all_projects: List[str] = list(master)
    for p in billed_projects:
        if p not in all_projects:
            all_projects.append(p)

    rows = []
    for proj in all_projects:
        p_df = billed[billed["Project_Clean"] == proj] if not billed.empty else pd.DataFrame()
        p_spend = df_spend[df_spend["Project_Clean"] == proj] if df_spend is not None else pd.DataFrame()
        row = {"project": proj}
        raw_total = 0.0

        for col in period_cols:
            col_billed = p_df[p_df[group_col] == col] if not p_df.empty else pd.DataFrame()
            col_spend = p_spend[p_spend[group_col] == col] if not p_spend.empty else pd.DataFrame()

            if measure == "sales":
                val = float(col_billed["Due_Num"].sum()) / 1e7 if not col_billed.empty else 0.0
            elif measure == "collections":
                val = float(col_billed["Paid_Num"].sum()) / 1e7 if not col_billed.empty else 0.0
            elif measure == "spend":
                val = float(col_spend["Amount"].sum()) / 1e7 if not col_spend.empty else 0.0
            else:  # surplus
                coll = float(col_billed["Paid_Num"].sum()) / 1e7 if not col_billed.empty else 0.0
                spend_val = float(col_spend["Amount"].sum()) / 1e7 if not col_spend.empty else 0.0
                val = coll - spend_val

            row[col] = round(val, 2)
            raw_total += val

        row["total"] = round(raw_total, 2)
        rows.append(row)  # always include all master projects

    rows.sort(key=lambda x: x["total"], reverse=True)

    return {
        "measure": measure,
        "periodType": period_type,
        "columns": period_cols,
        "note": "Sorted by total for chosen measure. Shading shows size. Sales/Collections from API; Construction spend from Excel historical data. Values in ₹ Cr.",
        "rows": rows
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8002, reload=True)
