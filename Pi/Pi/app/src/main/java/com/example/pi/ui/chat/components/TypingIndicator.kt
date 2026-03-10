package com.example.pi.ui.chat.components

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.keyframes
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.pi.ui.theme.Accent
import com.example.pi.ui.theme.TextSecondary

@Composable
fun TypingIndicator() {
    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.Start
    ) {
        // Avatar + name
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(bottom = 6.dp)
        ) {
            Box(
                modifier = Modifier
                    .size(24.dp)
                    .clip(CircleShape)
                    .background(
                        Brush.linearGradient(
                            colors = listOf(Accent, Color(0xFF34D399))
                        )
                    ),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    text = "✦",
                    fontSize = 12.sp,
                    color = Color.White
                )
            }

            Spacer(modifier = Modifier.width(8.dp))

            Text(
                text = "Her",
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
                color = TextSecondary
            )
        }

        // Pulse dots — matches Electron .thinking animation
        // CSS: opacity .15 → .7, period 1.4s, stagger 0.2s
        Row(
            modifier = Modifier.padding(start = 32.dp, top = 2.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp)
        ) {
            repeat(3) { index ->
                PulseDot(delayMs = index * 200)
            }
        }
    }
}

@Composable
private fun PulseDot(delayMs: Int) {
    val transition = rememberInfiniteTransition(label = "pulse")
    val alpha by transition.animateFloat(
        initialValue = 0.15f,
        targetValue = 0.15f,
        animationSpec = infiniteRepeatable(
            animation = keyframes {
                durationMillis = 1400
                0.15f at 0 + delayMs
                0.7f at 560 + delayMs  // 40% of 1400ms
                0.15f at 1120 + delayMs // 80% of 1400ms
                0.15f at 1400
            },
            repeatMode = RepeatMode.Restart
        ),
        label = "dotPulse"
    )

    Box(
        modifier = Modifier
            .size(6.dp)
            .clip(CircleShape)
            .background(Accent.copy(alpha = alpha))
    )
}
