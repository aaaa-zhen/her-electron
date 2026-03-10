package com.example.pi.ui.theme

import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

// Her Mint/Green Brand — matches Electron client
val Accent = Color(0xFF6EE7B7)
val AccentDim = Color(0xFF4DBFA0)
val AccentSurface = Color(0xFF1A2E28)

// Keep Orange aliases for backward compat in files we don't touch
val Orange = Accent
val OrangeDark = AccentDim
val OrangeLight = AccentSurface

data class HerColorPalette(
    val background: Color,
    val cardBg: Color,
    val textPrimary: Color,
    val textSecondary: Color,
    val textTertiary: Color,
    val aiBubbleBg: Color,
    val aiBubbleBorder: Color,
    val toolCallBg: Color,
    val toolCallBorder: Color,
    val userBubbleBg: Color,
    val suggestChipBg: Color
)

val HerColors = HerColorPalette(
    background = Color(0xFF0C0C0C),
    cardBg = Color(0xFF161616),
    textPrimary = Color(0xFFECECEC),
    textSecondary = Color(0xFF9A9A9A),
    textTertiary = Color(0xFF585858),
    aiBubbleBg = Color(0x0F6EE7B7),
    aiBubbleBorder = Color(0x1A6EE7B7),
    toolCallBg = Color(0x0F6EE7B7),
    toolCallBorder = Color(0x246EE7B7),
    userBubbleBg = Color(0x0DFFFFFF),
    suggestChipBg = Color(0xFF1E1E1E)
)

val HerColorsDark = HerColors  // Always dark — Her is dark-only

val LocalHerColors = staticCompositionLocalOf { HerColors }

// Convenience accessors
val Background: Color @Composable get() = LocalHerColors.current.background
val CardBg: Color @Composable get() = LocalHerColors.current.cardBg
val TextPrimary: Color @Composable get() = LocalHerColors.current.textPrimary
val TextSecondary: Color @Composable get() = LocalHerColors.current.textSecondary
val TextTertiary: Color @Composable get() = LocalHerColors.current.textTertiary
val AiBubbleBg: Color @Composable get() = LocalHerColors.current.aiBubbleBg
val AiBubbleBorder: Color @Composable get() = LocalHerColors.current.aiBubbleBorder
val ToolCallBg: Color @Composable get() = LocalHerColors.current.toolCallBg
val ToolCallBorder: Color @Composable get() = LocalHerColors.current.toolCallBorder
