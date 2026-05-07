# Phase 8D follow-up: light-mode visual correctness pass.
#
# Replaces hardcoded white/* and slate-* color literals with theme tokens
# so light + dark mode are both legible. The auth splash pages
# (auth/signin, auth/disabled) intentionally render on bg-slate-950
# regardless of theme — those are excluded.
#
# This script is idempotent: running it twice produces the same output.

$ErrorActionPreference = 'Stop'

$root = "C:\Code\MWG_CRM\src"

# Files to skip — intentionally hardcoded dark splash, or use color/alpha
# patterns that already work in both themes.
$skip = @(
    "auth\signin\page.tsx",
    "auth\signin\signin-form.tsx",
    "auth\signin\microsoft-button.tsx",
    "auth\disabled\page.tsx"
)

# Replacement table. Order matters: longer/more-specific patterns first.
# Each pair is (regex, replacement). Patterns are anchored so we don't
# eat partial classnames.
$pairs = @(
    # ----- borders -----
    @('\bborder-white/5\b',  'border-border/60'),
    @('\bborder-white/10\b', 'border-border'),
    @('\bborder-white/15\b', 'border-border'),
    @('\bborder-white/20\b', 'border-border'),
    @('\bborder-white/30\b', 'border-ring/60'),

    # ----- divides (table separators) -----
    @('\bdivide-white/5\b',  'divide-border/60'),
    @('\bdivide-white/10\b', 'divide-border'),

    # ----- backgrounds (translucent surfaces) -----
    @('\bbg-white/5\b',  'bg-muted/40'),
    @('\bbg-white/10\b', 'bg-muted'),
    @('\bbg-white/15\b', 'bg-muted'),
    @('\bbg-white/20\b', 'bg-muted'),

    # Button-style solid white surfaces (used as primary CTAs in dark mode).
    # Map to the theme primary so both modes get a proper CTA.
    @('\bbg-white/90\b', 'bg-primary'),
    @('\bbg-white/95\b', 'bg-primary'),
    @('\bhover:bg-white\b(?!/)',          'hover:bg-primary/90'),
    @('\bhover:bg-white/10\b',            'hover:bg-accent'),
    @('\bhover:bg-white/5\b',             'hover:bg-accent/60'),
    @('\bhover:bg-white/20\b',            'hover:bg-accent'),
    @('\bhover:bg-rose-500/20\b',         'hover:bg-destructive/20'),

    # ----- text (white literals) -----
    # text-white as a button label sitting on bg-primary becomes primary-foreground.
    # But 90% of usage is body content — map plain `text-white` to text-foreground.
    @('\btext-white\b(?!/)',  'text-foreground'),
    @('\btext-white/90\b',    'text-foreground'),
    @('\btext-white/80\b',    'text-foreground/90'),
    @('\btext-white/70\b',    'text-foreground/80'),
    @('\btext-white/60\b',    'text-muted-foreground'),
    @('\btext-white/50\b',    'text-muted-foreground'),
    @('\btext-white/40\b',    'text-muted-foreground/80'),
    @('\btext-white/30\b',    'text-muted-foreground/70'),
    @('\btext-white/20\b',    'text-muted-foreground/60'),
    @('\btext-white/85\b',    'text-foreground/90'),
    @('\btext-white/65\b',    'text-muted-foreground'),
    @('\btext-white/55\b',    'text-muted-foreground'),
    @('\btext-white/45\b',    'text-muted-foreground/80'),
    @('\btext-white/35\b',    'text-muted-foreground/70'),
    @('\btext-white/25\b',    'text-muted-foreground/70'),
    @('\bbg-white/\[0\.03\]\b', 'bg-muted/30'),
    @('\bhover:bg-white/\[0\.03\]\b', 'hover:bg-accent/40'),
    @('\bhover:text-white\b(?!/)', 'hover:text-foreground'),
    @('\bhover:text-white/80\b',   'hover:text-foreground'),
    @('\bhover:text-white/60\b',   'hover:text-foreground'),

    # ----- placeholder -----
    @('\bplaceholder-white/30\b',  'placeholder:text-muted-foreground/70'),
    @('\bplaceholder-white/40\b',  'placeholder:text-muted-foreground/70'),
    @('\bplaceholder-white/50\b',  'placeholder:text-muted-foreground'),

    # ----- focus rings -----
    @('\bfocus:border-white/30\b', 'focus:border-ring'),
    @('\bfocus:border-white/40\b', 'focus:border-ring'),
    @('\bfocus:ring-white/20\b',   'focus:ring-ring/40'),
    @('\bfocus:ring-white/30\b',   'focus:ring-ring/40'),

    # ----- slate text-* (used as light-on-dark labels) -----
    @('\btext-slate-50\b',  'text-foreground'),
    @('\btext-slate-100\b', 'text-foreground'),
    @('\btext-slate-200\b', 'text-foreground/90'),
    @('\btext-slate-300\b', 'text-muted-foreground'),
    @('\btext-slate-400\b', 'text-muted-foreground'),
    @('\btext-slate-500\b', 'text-muted-foreground'),
    @('\btext-slate-600\b', 'text-muted-foreground'),
    # text-slate-900 is typically text on a white CTA — should be primary-foreground.
    @('\btext-slate-700\b', 'text-foreground'),
    @('\btext-slate-800\b', 'text-foreground'),
    @('\btext-slate-900\b', 'text-primary-foreground'),

    @('\btext-zinc-50\b',  'text-foreground'),
    @('\btext-zinc-100\b', 'text-foreground'),
    @('\btext-zinc-200\b', 'text-foreground/90'),
    @('\btext-zinc-300\b', 'text-muted-foreground'),
    @('\btext-zinc-400\b', 'text-muted-foreground'),
    @('\btext-zinc-500\b', 'text-muted-foreground'),
    @('\btext-zinc-600\b', 'text-muted-foreground'),

    @('\btext-neutral-50\b',  'text-foreground'),
    @('\btext-neutral-100\b', 'text-foreground'),
    @('\btext-neutral-200\b', 'text-foreground/90'),
    @('\btext-neutral-300\b', 'text-muted-foreground'),
    @('\btext-neutral-400\b', 'text-muted-foreground'),
    @('\btext-neutral-500\b', 'text-muted-foreground'),
    @('\btext-neutral-600\b', 'text-muted-foreground'),

    @('\btext-gray-300\b', 'text-muted-foreground'),
    @('\btext-gray-400\b', 'text-muted-foreground'),
    @('\btext-gray-500\b', 'text-muted-foreground'),
    @('\btext-gray-600\b', 'text-muted-foreground'),
    @('\btext-gray-700\b', 'text-foreground'),
    @('\btext-gray-800\b', 'text-foreground'),
    @('\btext-gray-900\b', 'text-foreground'),

    # ----- slate/zinc backgrounds -----
    @('\bbg-slate-700\b', 'bg-muted'),
    @('\bbg-slate-800\b', 'bg-card'),
    @('\bbg-slate-900\b', 'bg-card'),
    @('\bbg-zinc-700\b',  'bg-muted'),
    @('\bbg-zinc-800\b',  'bg-card'),
    @('\bbg-zinc-900\b',  'bg-card'),

    @('\bborder-slate-700\b', 'border-border'),
    @('\bborder-slate-800\b', 'border-border'),
    @('\bborder-zinc-700\b',  'border-border'),
    @('\bborder-zinc-800\b',  'border-border')
)

$tsxFiles = Get-ChildItem -Path $root -Recurse -Filter '*.tsx' -File
$touched = 0
$report = @()

foreach ($file in $tsxFiles) {
    $rel = $file.FullName.Substring($root.Length + 1)
    if ($skip | Where-Object { $rel -like "*$_*" -or $rel -eq $_ }) { continue }

    $orig = Get-Content -LiteralPath $file.FullName -Raw
    $text = $orig
    $hits = 0

    foreach ($pair in $pairs) {
        $pattern = $pair[0]
        $replacement = $pair[1]
        $matches = [regex]::Matches($text, $pattern)
        if ($matches.Count -gt 0) {
            $hits += $matches.Count
            $text = [regex]::Replace($text, $pattern, $replacement)
        }
    }

    if ($text -ne $orig) {
        Set-Content -LiteralPath $file.FullName -Value $text -NoNewline -Encoding UTF8
        $touched += 1
        $report += "$rel : $hits replacements"
    }
}

Write-Host ""
Write-Host "===== Phase 8D light-mode fix summary ====="
Write-Host "Files touched: $touched"
Write-Host ""
$report | ForEach-Object { Write-Host $_ }
