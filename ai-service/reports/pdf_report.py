"""
FSOC PAT — PDF Report Generator
Produces a professional engineering report using ReportLab.
"""
import io
import time
from typing import Optional
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Table,
                                 TableStyle, HRFlowable, KeepTogether)
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT
from database.models import get_run, get_telemetry


# ── Colour palette ────────────────────────────────────────────
GRAPHITE = colors.HexColor('#1a1f1f')
DARK_BG = colors.HexColor('#0e1212')
CYAN_ACCENT = colors.HexColor('#5fb3c0')
LIGHT_TEXT = colors.HexColor('#d4dde0')
MID_TEXT = colors.HexColor('#8a9ba0')
BORDER = colors.HexColor('#2a3535')
SUCCESS = colors.HexColor('#4caf82')
WARNING = colors.HexColor('#e0a040')
ERROR_C = colors.HexColor('#c0504a')


def _ts(ts: Optional[float]) -> str:
    if ts is None:
        return '—'
    return time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(ts))


def generate_pdf(run_id: str) -> bytes:
    """Generate a PDF engineering report and return as bytes."""
    run = get_run(run_id)
    if not run:
        # Return a minimal error PDF
        buf = io.BytesIO()
        doc = SimpleDocTemplate(buf, pagesize=A4)
        styles = getSampleStyleSheet()
        doc.build([Paragraph(f'Run {run_id} not found.', styles['Normal'])])
        return buf.getvalue()

    samples = get_telemetry(run_id, limit=1000)

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=20 * mm,
        rightMargin=20 * mm,
        topMargin=25 * mm,
        bottomMargin=20 * mm,
        title=f'FSOC PAT Report — {run_id[:8]}',
        author='FSOC Virtual PAT System',
    )

    styles = getSampleStyleSheet()

    # Custom paragraph styles
    title_style = ParagraphStyle(
        'FSTitle',
        parent=styles['Title'],
        fontSize=18,
        textColor=LIGHT_TEXT,
        spaceAfter=4,
        fontName='Helvetica-Bold',
    )
    subtitle_style = ParagraphStyle(
        'FSSub',
        parent=styles['Normal'],
        fontSize=9,
        textColor=CYAN_ACCENT,
        spaceAfter=12,
        fontName='Helvetica',
    )
    section_style = ParagraphStyle(
        'FSSection',
        parent=styles['Heading2'],
        fontSize=11,
        textColor=CYAN_ACCENT,
        spaceBefore=14,
        spaceAfter=4,
        fontName='Helvetica-Bold',
    )
    body_style = ParagraphStyle(
        'FSBody',
        parent=styles['Normal'],
        fontSize=9,
        textColor=LIGHT_TEXT,
        leading=14,
    )
    mono_style = ParagraphStyle(
        'FSMono',
        parent=styles['Code'],
        fontSize=8,
        textColor=MID_TEXT,
        fontName='Courier',
    )

    def hr():
        return HRFlowable(width='100%', thickness=0.5,
                          color=BORDER, spaceAfter=6, spaceBefore=6)

    def section(title: str):
        return Paragraph(title.upper(), section_style)

    def kv_table(rows: list[tuple[str, str]]) -> Table:
        data = [[Paragraph(k, mono_style), Paragraph(str(v), body_style)]
                for k, v in rows]
        t = Table(data, colWidths=[60 * mm, 100 * mm])
        t.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (0, -1), colors.HexColor('#111818')),
            ('TEXTCOLOR', (0, 0), (0, -1), CYAN_ACCENT),
            ('FONTNAME', (0, 0), (0, -1), 'Courier-Bold'),
            ('FONTSIZE', (0, 0), (-1, -1), 8),
            ('ROWBACKGROUNDS', (0, 0), (-1, -1),
             [colors.HexColor('#131c1c'), colors.HexColor('#0e1515')]),
            ('GRID', (0, 0), (-1, -1), 0.3, BORDER),
            ('LEFTPADDING', (0, 0), (-1, -1), 6),
            ('RIGHTPADDING', (0, 0), (-1, -1), 6),
            ('TOPPADDING', (0, 0), (-1, -1), 3),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
        ]))
        return t

    # ── Build content ─────────────────────────────────────────
    content = []

    # Header
    content.append(Paragraph('FSOC VIRTUAL PAT', title_style))
    content.append(Paragraph('AI-Assisted Coarse Alignment &amp; Tracking System', subtitle_style))
    content.append(Paragraph('SIMULATION PERFORMANCE REPORT', subtitle_style))
    content.append(hr())
    content.append(Spacer(1, 4))

    # Mission info
    content.append(section('1. Mission Information'))
    content.append(kv_table([
        ('Run ID', run.get('run_id', '—')[:16] + '…'),
        ('Scenario', run.get('scenario_name', '—')),
        ('Environment', run.get('environment', '—').upper()),
        ('Start Time', _ts(run.get('started_at'))),
        ('End Time', _ts(run.get('ended_at'))),
        ('Status', run.get('status', '—').upper()),
        ('Final State', run.get('final_state', '—')),
    ]))

    # Performance
    content.append(Spacer(1, 6))
    content.append(section('2. Tracking Performance'))

    acq = run.get('acquisition_time')
    acq_str = f"{acq:.3f} s" if acq else "Not acquired"

    status = run.get('final_state', '')
    lock_ret = run.get('lock_retention', 0) or 0
    avg_reacq = run.get('avg_reacquisition_time')
    avg_reacq_str = f"{avg_reacq:.3f} s" if avg_reacq else "—"
    max_reacq = run.get('max_reacquisition_time')
    max_reacq_str = f"{max_reacq:.3f} s" if max_reacq else "—"

    dur = run.get('duration') or 0.0
    fps_val = run.get('avg_fps') or 0.0
    avg_err_val = run.get('average_error') or 0.0
    max_err_val = run.get('max_error') or 0.0
    proc_ms_val = run.get('processing_ms') or 0.0
    det_conf = (run.get('detection_confidence') or 0.0) * 100

    content.append(kv_table([
        ('Duration',               f"{dur:.2f} s"),
        ('Average FPS',            f"{fps_val:.1f}"),
        ('Acquisition Time',       acq_str),
        ('Avg Re-acquisition Time', avg_reacq_str),
        ('Max Re-acquisition Time', max_reacq_str),
        ('Average Tracking Error', f"{avg_err_val:.4f}°"),
        ('Maximum Tracking Error', f"{max_err_val:.4f}°"),
        ('Lock Retention',         f"{lock_ret:.2f}%"),
        ('Target Loss Count',      str(run.get('lost_count') or '—')),
        ('Re-acquisition Count',   str(run.get('reacquisition_count') or '—')),
        ('Detection Confidence',   f"{det_conf:.1f}%"),
        ('Avg Processing Latency', f"{proc_ms_val:.2f} ms"),
        ('Total Frames',           str(run.get('total_frames') or '—')),
    ]))

    # PS4 Compliance Table
    content.append(Spacer(1, 6))
    content.append(section('3. PS4 Spec Compliance'))
    avg_err_deg = run.get('average_error', 0) or 0
    max_err_deg = run.get('max_error', 0) or 0
    avg_fps_val = run.get('avg_fps', 0) or 0
    proc_ms_val = run.get('processing_ms', 0) or 0

    def spec_row(param, req, actual, passed):
        color = SUCCESS if passed else ERROR_C
        return [
            Paragraph(param, mono_style),
            Paragraph(req, body_style),
            Paragraph(actual, ParagraphStyle('SpecVal', parent=body_style, textColor=color)),
            Paragraph('PASS' if passed else 'FAIL',
                      ParagraphStyle('SpecStatus', parent=body_style,
                                     textColor=SUCCESS if passed else ERROR_C,
                                     fontName='Helvetica-Bold')),
        ]

    # Convert degrees to approximate pixels (1° ≈ 22.7px at 640×480, 28° FOV)
    px_per_deg = 640 / 28.0
    avg_err_px = avg_err_deg * px_per_deg
    max_err_px = max_err_deg * px_per_deg

    spec_data = [
        [Paragraph('Parameter', mono_style), Paragraph('Requirement', body_style),
         Paragraph('Actual', body_style), Paragraph('Status', body_style)],
        spec_row('Acquisition Time', '≤ 2.0 s', acq_str,
                 acq is not None and acq <= 2.0),
        spec_row('Avg Tracking Error', '≤ 10 px', f"{avg_err_px:.1f} px",
                 avg_err_px <= 10.0),
        spec_row('Re-acquisition Time', '≤ 1.0 s', avg_reacq_str,
                 avg_reacq is None or avg_reacq <= 1.0),
        spec_row('Lock Retention', '> 95%', f"{lock_ret:.1f}%",
                 lock_ret >= 95.0),
        spec_row('Processing Speed', '≥ 20 FPS', f"{avg_fps_val:.1f} FPS",
                 avg_fps_val >= 20.0),
        spec_row('Proc Latency (50 ms budget)', '≤ 50 ms', f"{proc_ms_val:.1f} ms",
                 proc_ms_val <= 50.0),
    ]
    spec_table = Table(spec_data, colWidths=[50*mm, 40*mm, 40*mm, 25*mm])
    spec_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#111818')),
        ('TEXTCOLOR', (0, 0), (-1, 0), CYAN_ACCENT),
        ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
        ('FONTSIZE', (0, 0), (-1, -1), 8),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1),
         [colors.HexColor('#131c1c'), colors.HexColor('#0e1515')]),
        ('GRID', (0, 0), (-1, -1), 0.3, BORDER),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
        ('RIGHTPADDING', (0, 0), (-1, -1), 6),
        ('TOPPADDING', (0, 0), (-1, -1), 3),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
    ]))
    content.append(spec_table)

    # Error statistics
    if samples:
        errors = [s.get('total_error', 0) or 0 for s in samples]
        pct_locked = sum(1 for s in samples if s.get('target_state') == 'LOCKED') / len(samples) * 100
        sorted_e = sorted(errors)
        p95 = sorted_e[int(len(sorted_e) * 0.95)] if sorted_e else 0

        content.append(Spacer(1, 6))
        content.append(section('4. Error Statistics'))
        content.append(kv_table([
            ('Mean Error',           f"{sum(errors)/len(errors):.4f}°"),
            ('Median Error',         f"{sorted_e[len(sorted_e)//2]:.4f}°"),
            ('95th Percentile Error',f"{p95:.4f}°"),
            ('Peak Error',           f"{max(errors):.4f}°"),
            ('% Frames Locked',      f"{pct_locked:.1f}%"),
            ('Total Frames Sampled', str(len(samples))),
        ]))


    # Footer
    content.append(Spacer(1, 12))
    content.append(hr())
    content.append(Paragraph(
        f'Generated by FSOC Virtual PAT — {_ts(time.time())}',
        ParagraphStyle('Footer', parent=styles['Normal'],
                       fontSize=7, textColor=MID_TEXT,
                       alignment=TA_CENTER)
    ))

    doc.build(content)
    return buf.getvalue()
