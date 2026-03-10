package com.example.pi.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.graphics.Color

private val HerColorScheme = darkColorScheme(
    primary = Accent,
    onPrimary = Color(0xFF0C0C0C),
    primaryContainer = AccentSurface,
    onPrimaryContainer = Accent,
    secondary = AccentDim,
    onSecondary = Color(0xFF0C0C0C),
    background = Color(0xFF0C0C0C),
    onBackground = Color(0xFFECECEC),
    surface = Color(0xFF0C0C0C),
    onSurface = Color(0xFFECECEC),
    surfaceVariant = Color(0xFF161616),
    onSurfaceVariant = Color(0xFF9A9A9A),
    error = Color(0xFFF87171),
    errorContainer = Color(0xFF3A1010),
    onErrorContainer = Color(0xFFFFDAD6),
)

@Composable
fun HerTheme(
    darkTheme: Boolean = true,
    content: @Composable () -> Unit
) {
    CompositionLocalProvider(LocalHerColors provides HerColors) {
        MaterialTheme(
            colorScheme = HerColorScheme,
            typography = Typography,
            content = content
        )
    }
}

// Keep old name as alias for any straggling references
@Composable
fun PiTheme(
    darkTheme: Boolean = true,
    content: @Composable () -> Unit
) = HerTheme(darkTheme, content)
