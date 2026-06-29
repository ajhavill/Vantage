# Generates a detailed, illustrative office-lease PROPOSAL (LOI) PDF for testing
# the deal-flow document upload. All terms are fabricated sample data.
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Table,
                                TableStyle, HRFlowable, ListFlowable, ListItem)

NAVY = colors.HexColor("#1B2A4A")
ACCENT = colors.HexColor("#2D6E7E")
INK = colors.HexColor("#1A2230")
SOFT = colors.HexColor("#55606F")
LINE = colors.HexColor("#D2CCBF")
PAPER2 = colors.HexColor("#FCFBF8")

styles = getSampleStyleSheet()
H = ParagraphStyle("H", parent=styles["Normal"], fontName="Helvetica-Bold",
                   fontSize=11, textColor=NAVY, spaceBefore=12, spaceAfter=5, leading=14)
BODY = ParagraphStyle("BODY", parent=styles["Normal"], fontName="Helvetica",
                      fontSize=9.3, textColor=INK, leading=13.5, spaceAfter=4, alignment=4)
SMALL = ParagraphStyle("SMALL", parent=styles["Normal"], fontName="Helvetica",
                       fontSize=7.6, textColor=SOFT, leading=10)
CELL = ParagraphStyle("CELL", parent=styles["Normal"], fontName="Helvetica", fontSize=8.6, textColor=INK, leading=11.5)
CELLB = ParagraphStyle("CELLB", parent=CELL, fontName="Helvetica-Bold")

def hr():
    return HRFlowable(width="100%", thickness=0.7, color=LINE, spaceBefore=4, spaceAfter=8)

story = []

# ---- Letterhead ----
lh = Table([[
    Paragraph('<font color="#1B2A4A"><b>MERIDIAN&nbsp;WEST</b></font><br/>'
              '<font color="#55606F" size=7.5>COMMERCIAL&nbsp;REAL&nbsp;ESTATE&nbsp;&bull;&nbsp;LANDLORD&nbsp;REPRESENTATION</font>', BODY),
    Paragraph('<para align=right><font color="#55606F" size=7.5>1801 Century Park East, Suite 1400<br/>'
              'Los Angeles, CA 90067&nbsp;&bull;&nbsp;(310) 555-0142<br/>License No. 01998877</font></para>', SMALL),
]], colWidths=[3.4*inch, 3.4*inch])
lh.setStyle(TableStyle([("VALIGN",(0,0),(-1,-1),"TOP"),("LEFTPADDING",(0,0),(-1,-1),0),("RIGHTPADDING",(0,0),(-1,-1),0)]))
story += [lh, hr()]

story.append(Paragraph('<para align=center><font color="#1B2A4A" size=15><b>PROPOSAL TO LEASE</b></font><br/>'
                       '<font color="#55606F" size=9>Non-Binding Letter of Intent &mdash; Office Space</font></para>',
                       ParagraphStyle("T", parent=BODY, alignment=1, spaceAfter=10)))

meta = Table([
    [Paragraph("<b>Date</b>", CELL), Paragraph("June 29, 2026", CELL),
     Paragraph("<b>Proposal No.</b>", CELL), Paragraph("MW-2026-0488", CELL)],
    [Paragraph("<b>Property</b>", CELL), Paragraph("The Water Garden &mdash; 2425 Olympic Blvd, Santa Monica, CA 90404", CELL),
     Paragraph("<b>Suite</b>", CELL), Paragraph("350 (3rd Floor)", CELL)],
], colWidths=[0.85*inch, 3.05*inch, 0.9*inch, 2.0*inch])
meta.setStyle(TableStyle([
    ("BOX",(0,0),(-1,-1),0.7,LINE),("INNERGRID",(0,0),(-1,-1),0.4,LINE),
    ("BACKGROUND",(0,0),(-1,-1),PAPER2),("VALIGN",(0,0),(-1,-1),"MIDDLE"),
    ("TOPPADDING",(0,0),(-1,-1),5),("BOTTOMPADDING",(0,0),(-1,-1),5),
    ("LEFTPADDING",(0,0),(-1,-1),7),("RIGHTPADDING",(0,0),(-1,-1),7),
]))
story += [meta, Spacer(1, 10)]

story.append(Paragraph(
    "On behalf of the Landlord, Meridian West Commercial is pleased to present the following non-binding "
    "proposal for your client&rsquo;s consideration. This Letter of Intent outlines the principal business "
    "terms under which the Landlord would be prepared to lease the above-referenced premises. It is intended "
    "solely as a basis for further negotiation and creates no legal obligation on either party until a "
    "mutually executed lease is delivered.", BODY))

# ---- Parties ----
story.append(Paragraph("1.&nbsp;&nbsp;Parties", H))
parties = Table([
    [Paragraph("<b>Landlord</b>", CELL), Paragraph("WG Olympic Owner, LLC, a Delaware limited liability company", CELL)],
    [Paragraph("<b>Landlord&rsquo;s Broker</b>", CELL), Paragraph("Meridian West Commercial (Daniel Reyes, lic. 01998877)", CELL)],
    [Paragraph("<b>Tenant</b>", CELL), Paragraph("Northpoint Analytics, Inc., a California corporation", CELL)],
    [Paragraph("<b>Tenant&rsquo;s Broker</b>", CELL), Paragraph("Havill &amp; Co. (procuring cause; commission per separate agreement)", CELL)],
], colWidths=[1.5*inch, 5.3*inch])
parties.setStyle(TableStyle([
    ("INNERGRID",(0,0),(-1,-1),0.4,LINE),("BOX",(0,0),(-1,-1),0.7,LINE),
    ("VALIGN",(0,0),(-1,-1),"MIDDLE"),("TOPPADDING",(0,0),(-1,-1),4),("BOTTOMPADDING",(0,0),(-1,-1),4),
    ("LEFTPADDING",(0,0),(-1,-1),7),("RIGHTPADDING",(0,0),(-1,-1),7),
]))
story += [parties, Spacer(1, 2)]

# ---- Premises ----
story.append(Paragraph("2.&nbsp;&nbsp;Premises", H))
story.append(Paragraph(
    "Suite 350, located on the third (3rd) floor of the West Tower, comprising approximately "
    "<b>12,480 rentable square feet</b> (10,857 usable square feet; load factor 15.0%). The premises "
    "shall be delivered in their current second-generation condition, broom-clean, with all building "
    "systems in good working order. The premises benefit from operable skylights, exposed-ceiling creative "
    "improvements, two existing conference rooms, a private restroom, and a plumbed kitchen/break area.", BODY))

# ---- Term & rent ----
story.append(Paragraph("3.&nbsp;&nbsp;Lease Term &amp; Commencement", H))
story.append(Paragraph(
    "<b>Eighty-four (84) months</b> (seven years). The estimated Commencement Date is <b>October 1, 2026</b>, "
    "with an Expiration Date of <b>September 30, 2033</b>. Tenant shall be granted early access up to thirty (30) "
    "days prior to the Commencement Date for the installation of furniture, fixtures, cabling, and equipment, "
    "rent-free, subject to a certificate of insurance and coordination with the Landlord&rsquo;s contractor.", BODY))

story.append(Paragraph("4.&nbsp;&nbsp;Base Rent (Full-Service Gross)", H))
story.append(Paragraph(
    "Base Rent is quoted on a <b>Full-Service Gross</b> basis at an initial rate of <b>$5.95 per rentable "
    "square foot, per month</b> ($71.40/RSF/year), increasing <b>three percent (3.0%)</b> on each annual "
    "anniversary of the Commencement Date, per the schedule below:", BODY))

rows = [["Lease Year", "Rate ($/RSF/mo)", "Rate ($/RSF/yr)", "Monthly Base Rent", "Annual Base Rent"]]
rate = 5.95
rsf = 12480
for yr in range(1, 8):
    annual_psf = rate * 12
    monthly = rate * rsf
    annual = monthly * 12
    rows.append([f"Year {yr}", f"${rate:,.2f}", f"${annual_psf:,.2f}",
                 f"${monthly:,.0f}", f"${annual:,.0f}"])
    rate = round(rate * 1.03, 2)
rent_tbl = Table(rows, colWidths=[0.95*inch, 1.25*inch, 1.25*inch, 1.55*inch, 1.55*inch])
rent_tbl.setStyle(TableStyle([
    ("BACKGROUND",(0,0),(-1,0),NAVY),("TEXTCOLOR",(0,0),(-1,0),colors.white),
    ("FONTNAME",(0,0),(-1,0),"Helvetica-Bold"),("FONTSIZE",(0,0),(-1,-1),8.4),
    ("FONTNAME",(0,1),(-1,-1),"Helvetica"),("ALIGN",(1,0),(-1,-1),"RIGHT"),
    ("ALIGN",(0,0),(0,-1),"LEFT"),("VALIGN",(0,0),(-1,-1),"MIDDLE"),
    ("ROWBACKGROUNDS",(0,1),(-1,-1),[colors.white, PAPER2]),
    ("INNERGRID",(0,0),(-1,-1),0.4,LINE),("BOX",(0,0),(-1,-1),0.7,LINE),
    ("TOPPADDING",(0,0),(-1,-1),4),("BOTTOMPADDING",(0,0),(-1,-1),4),
    ("LEFTPADDING",(0,0),(-1,-1),6),("RIGHTPADDING",(0,0),(-1,-1),6),
]))
story += [rent_tbl, Spacer(1, 4)]

# ---- Operating expenses ----
story.append(Paragraph("5.&nbsp;&nbsp;Operating Expenses &amp; Taxes", H))
story.append(Paragraph(
    "Full-Service Gross with a <b>Base Year of 2026</b>. Tenant shall pay its pro-rata share "
    "(approximately <b>4.18%</b>) of increases in Operating Expenses and Real Property Taxes over the Base "
    "Year amount. Controllable operating expenses shall not increase by more than <b>five percent (5%)</b> "
    "per year on a cumulative, compounding basis. Operating expenses are currently estimated at $13.80/RSF/year.", BODY))

# ---- Concessions ----
story.append(Paragraph("6.&nbsp;&nbsp;Rent Abatement", H))
story.append(Paragraph(
    "Provided Tenant is not in default, Base Rent shall be <b>abated in full for the first four (4) months</b> "
    "of the Term (Months 1&ndash;4). Tenant remains responsible for parking charges and after-hours HVAC, if any, "
    "during the abatement period.", BODY))

story.append(Paragraph("7.&nbsp;&nbsp;Tenant Improvement Allowance", H))
story.append(Paragraph(
    "Landlord shall provide a Tenant Improvement Allowance of <b>$65.00 per rentable square foot</b> "
    "(approximately $811,200 in the aggregate) toward the design, permitting, and construction of Tenant&rsquo;s "
    "improvements. Any unused portion remaining twelve (12) months after the Commencement Date may be applied, "
    "up to $10.00/RSF, as a credit against Base Rent. The Allowance excludes Landlord&rsquo;s 2.5% construction "
    "management fee.", BODY))

# ---- Parking ----
story.append(Paragraph("8.&nbsp;&nbsp;Parking", H))
story.append(Paragraph(
    "Tenant shall have the right to <b>3.0 parking permits per 1,000 RSF (37 permits total)</b> in the subterranean "
    "garage. Initial rates: <b>$165 per unreserved permit / month</b> and <b>$250 per reserved permit / month</b>, "
    "subject to market adjustment. Up to four (4) permits may be converted to reserved at Tenant&rsquo;s election. "
    "Rates are abated 50% during the four-month abatement period.", BODY))

# ---- Security deposit ----
story.append(Paragraph("9.&nbsp;&nbsp;Security Deposit", H))
story.append(Paragraph(
    "A Security Deposit equal to <b>$75,000</b> (approximately one month of fully-escalated Base Rent) shall be "
    "due upon lease execution. Subject to Tenant maintaining no monetary defaults, the deposit shall burn down by "
    "one-third at the end of Months 24 and 48, with the balance refundable at expiration.", BODY))

# ---- Options ----
story.append(Paragraph("10.&nbsp;&nbsp;Options &amp; Rights", H))
opts = ListFlowable([
    ListItem(Paragraph("<b>Renewal Option:</b> One (1) option to renew for five (5) years at ninety-five percent "
                       "(95%) of the prevailing Fair Market Rental Rate, on twelve (12) months&rsquo; prior written notice.", BODY)),
    ListItem(Paragraph("<b>Right of First Offer:</b> Ongoing ROFO on contiguous Suite 360 (approx. 4,300 RSF) "
                       "should it become available during the Term.", BODY)),
    ListItem(Paragraph("<b>Termination Option:</b> One-time right to terminate effective at the end of Month 60 "
                       "upon nine (9) months&rsquo; notice and payment of a termination fee equal to the unamortized "
                       "Transaction Costs (TI, abatement, and commissions) at 8% interest.", BODY)),
    ListItem(Paragraph("<b>Building Signage:</b> Tenant shall receive lobby-directory and suite-entry signage; "
                       "eyebrow signage subject to Landlord and City approval.", BODY)),
], bulletType="bullet", start="square", leftIndent=14)
story += [opts]

# ---- Other terms ----
story.append(Paragraph("11.&nbsp;&nbsp;Additional Terms", H))
story.append(Paragraph(
    "<b>Use:</b> General office and ancillary uses consistent with a first-class office building. "
    "<b>Building Hours:</b> 7:00 a.m.&ndash;7:00 p.m. weekdays, 8:00 a.m.&ndash;1:00 p.m. Saturdays; after-hours HVAC "
    "at $55/hour per zone. <b>Assignment/Subletting:</b> Permitted with Landlord&rsquo;s consent, not to be "
    "unreasonably withheld; Permitted Transfers to affiliates and successors without consent. <b>Condition:</b> "
    "Landlord warrants that building systems, roof, and the existing restrooms will be in good working order and "
    "ADA-compliant as of delivery. <b>Contingencies:</b> This proposal is subject to Landlord&rsquo;s receipt and "
    "approval of Tenant&rsquo;s current financial statements and to mutual approval of a definitive lease document "
    "on the Landlord&rsquo;s standard form, as modified by negotiation.", BODY))

# ---- Expiration & signature ----
story.append(Paragraph("12.&nbsp;&nbsp;Acceptance &amp; Expiration", H))
story.append(Paragraph(
    "This proposal shall remain open for acceptance for <b>ten (10) business days</b> from the date hereof, after "
    "which it shall expire unless extended in writing by the Landlord. This Letter of Intent is non-binding and is "
    "intended only to facilitate negotiation; neither party shall be bound until a definitive lease is fully "
    "executed and delivered.", BODY))
story.append(Spacer(1, 14))

sig = Table([
    [Paragraph("Respectfully submitted,", CELL), Paragraph("Acknowledged &amp; received:", CELL)],
    [Paragraph("<br/><br/>______________________________<br/><b>Daniel Reyes</b><br/>"
               "<font size=7.5 color='#55606F'>Meridian West Commercial<br/>For and on behalf of the Landlord</font>", CELL),
     Paragraph("<br/><br/>______________________________<br/><b>Northpoint Analytics, Inc.</b><br/>"
               "<font size=7.5 color='#55606F'>By: _______________  Date: __________</font>", CELL)],
], colWidths=[3.4*inch, 3.4*inch])
sig.setStyle(TableStyle([("VALIGN",(0,0),(-1,-1),"TOP"),("LEFTPADDING",(0,0),(-1,-1),0),("TOPPADDING",(0,0),(-1,-1),2)]))
story += [sig, Spacer(1, 10), hr()]
story.append(Paragraph(
    "ILLUSTRATIVE SAMPLE &mdash; This document and all parties, figures, and terms herein are fictitious and were "
    "generated solely to test the Vantage deal-flow document workflow. It is not an offer and references no real "
    "transaction.", SMALL))

doc = SimpleDocTemplate("Sample-Office-Lease-Proposal.pdf", pagesize=letter,
                        topMargin=0.6*inch, bottomMargin=0.55*inch, leftMargin=0.7*inch, rightMargin=0.7*inch,
                        title="Proposal to Lease - The Water Garden, Suite 350",
                        author="Meridian West Commercial (sample)")
doc.build(story)
print("OK wrote Sample-Office-Lease-Proposal.pdf")
