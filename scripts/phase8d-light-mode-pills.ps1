# Phase 8D follow-up part 2: pill / chip color literals.
#
# Status / rating / source / role / etc. pills use the pattern
#   bg-<color>-500/10 text-<color>-100 border-<color>-300/30
# tuned for dark-glass surfaces. On light surfaces, text-color-100 is
# essentially white-on-white. This script converts each pill chip to a
# dark-mode-aware variant: light-mode uses *-700 text + *-500/15 bg,
# dark-mode keeps the original *-100 text + *-500/10 bg.
#
# Idempotent.

$ErrorActionPreference = 'Stop'

$root = "C:\Code\MWG_CRM\src"

$colors = @(
    'blue', 'cyan', 'emerald', 'rose', 'amber', 'violet', 'sky',
    'orange', 'green', 'yellow', 'purple', 'pink', 'red', 'fuchsia',
    'indigo', 'teal', 'lime'
)

# Skip auth pages (intentional dark splash).
$skip = @(
    "auth\signin\page.tsx",
    "auth\signin\signin-form.tsx",
    "auth\signin\microsoft-button.tsx",
    "auth\disabled\page.tsx"
)

$pairs = @()
foreach ($c in $colors) {
    # Pill text — pale in dark-mode, deep in light-mode.
    $pairs += , @("\btext-$c-100\b", "text-$c-700 dark:text-$c-100")
    $pairs += , @("\btext-$c-200\b", "text-$c-700 dark:text-$c-200")
    $pairs += , @("\btext-$c-300\b", "text-$c-700 dark:text-$c-300")

    # Pill body backgrounds — slightly more saturated in light mode.
    $pairs += , @("\bbg-$c-500/10\b", "bg-$c-500/15 dark:bg-$c-500/10")
    $pairs += , @("\bbg-$c-500/15\b", "bg-$c-500/20 dark:bg-$c-500/15")

    # Pill borders — needed extra contrast in light mode.
    $pairs += , @("\bborder-$c-300/30\b", "border-$c-500/30 dark:border-$c-300/30")
    $pairs += , @("\bborder-$c-400/30\b", "border-$c-500/30 dark:border-$c-400/30")
}

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
Write-Host "===== Phase 8D pill-color fix summary ====="
Write-Host "Files touched: $touched"
Write-Host ""
$report | ForEach-Object { Write-Host $_ }
