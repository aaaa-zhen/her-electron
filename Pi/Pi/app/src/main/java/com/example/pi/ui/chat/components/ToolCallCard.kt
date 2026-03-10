package com.example.pi.ui.chat.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.pi.ui.theme.AccentDim
import com.example.pi.ui.theme.TextSecondary
import com.example.pi.ui.theme.ToolCallBg
import com.example.pi.ui.theme.ToolCallBorder

@Composable
fun ToolCallCard(
    toolName: String,
    content: String,
    modifier: Modifier = Modifier
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(ToolCallBg)
            .border(1.dp, ToolCallBorder, RoundedCornerShape(8.dp))
            .padding(10.dp)
    ) {
        Text(
            text = toolName,
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
            fontFamily = FontFamily.Monospace,
            color = AccentDim
        )
        Text(
            text = content,
            fontSize = 13.sp,
            color = TextSecondary,
            modifier = Modifier.padding(top = 4.dp)
        )
    }
}
