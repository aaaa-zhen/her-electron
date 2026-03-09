package com.example.pi.ui.chat.components

import android.net.Uri
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.example.pi.R
import com.example.pi.ui.chat.UiMessage
import com.example.pi.ui.theme.Accent
import com.example.pi.ui.theme.AccentDim
import com.example.pi.ui.theme.TextPrimary
import com.example.pi.ui.theme.TextSecondary
import com.example.pi.ui.theme.TextTertiary
import com.example.pi.ui.theme.ToolCallBg
import com.example.pi.ui.theme.ToolCallBorder

@Composable
fun MessageBubble(
    message: UiMessage,
    modifier: Modifier = Modifier,
    showAvatar: Boolean = true
) {
    val isUser = message.role == "user"
    val isTool = message.role == "tool"

    when {
        isTool -> ToolCallBubble(message, modifier)
        isUser -> UserBubble(message, modifier)
        else -> AiBubble(message, modifier, showAvatar)
    }
}

@Composable
fun AiAvatarHeader(modifier: Modifier = Modifier) {
    AiAvatarRow(modifier)
}

@Composable
private fun AiAvatarRow(modifier: Modifier = Modifier) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = modifier.padding(bottom = 6.dp)
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
}

@Composable
private fun AiBubble(message: UiMessage, modifier: Modifier = Modifier, showAvatar: Boolean = true) {
    Column(
        modifier = modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.Start
    ) {
        if (showAvatar) {
            AiAvatarRow()
        }

        // Check if content contains image references
        val imagePattern = Regex("""\[(?:图片|image|img)]\((.*?)\)""", RegexOption.IGNORE_CASE)
        val imageMatches = imagePattern.findAll(message.content)
        val imageUrls = imageMatches.map { it.groupValues[1] }.toList()
        val textContent = imagePattern.replace(message.content, "").trim()

        if (imageUrls.isNotEmpty()) {
            LazyRow(
                modifier = Modifier.padding(start = 32.dp, bottom = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                items(imageUrls) { url ->
                    AsyncImage(
                        model = url,
                        contentDescription = "Image",
                        modifier = Modifier
                            .widthIn(max = 240.dp)
                            .height(180.dp)
                            .clip(RoundedCornerShape(12.dp)),
                        contentScale = ContentScale.Crop
                    )
                }
            }
        }

        if (textContent.isNotBlank()) {
            MarkdownText(
                text = textContent,
                color = TextPrimary,
                modifier = Modifier.padding(start = 32.dp)
            )
        }
    }
}

@Composable
private fun UserBubble(message: UiMessage, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.End
    ) {
        if (!message.imageUris.isNullOrEmpty()) {
            LazyRow(
                modifier = Modifier.padding(bottom = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                items(message.imageUris) { uri ->
                    AsyncImage(
                        model = uri,
                        contentDescription = "Sent image",
                        modifier = Modifier
                            .size(200.dp)
                            .clip(RoundedCornerShape(12.dp)),
                        contentScale = ContentScale.Crop
                    )
                }
            }
        }

        if (message.content.isNotBlank() && message.content != "[图片]") {
            val bubbleShape = RoundedCornerShape(
                topStart = 16.dp,
                topEnd = 16.dp,
                bottomStart = 16.dp,
                bottomEnd = 4.dp
            )
            Box(
                modifier = Modifier
                    .widthIn(max = 280.dp)
                    .clip(bubbleShape)
                    .background(Color.White.copy(alpha = 0.05f))
                    .border(1.dp, Color.White.copy(alpha = 0.07f), bubbleShape)
                    .padding(horizontal = 16.dp, vertical = 10.dp)
            ) {
                Text(
                    text = message.content,
                    fontSize = 15.sp,
                    lineHeight = 24.sp,
                    color = TextPrimary
                )
            }
        }
    }
}

private fun toolDisplayName(name: String?): String = when (name) {
    "memory_read" -> "查找记忆"
    "memory_write" -> "写入记忆"
    "set_reminder" -> "设置提醒"
    "set_alarm" -> "设置闹钟"
    "create_calendar_event" -> "创建日历"
    "web_search" -> "搜索网络"
    "create_event" -> "创建事件"
    "cancel_event" -> "取消事件"
    "list_events" -> "查看事件"
    "execute_command" -> "执行终端命令"
    "read_file" -> "读取文件"
    "write_file" -> "写入文件"
    "list_directory" -> "查看目录"
    "browser_navigate" -> "浏览网页"
    else -> name ?: "工具"
}

@Composable
private fun ToolCallBubble(message: UiMessage, modifier: Modifier = Modifier) {
    val isProcessing = message.content.isBlank()
    var expanded by remember { mutableStateOf(false) }

    Column(
        modifier = modifier
            .padding(start = 32.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(ToolCallBg)
            .border(1.dp, ToolCallBorder, RoundedCornerShape(12.dp))
            .clickable { if (!isProcessing) expanded = !expanded }
            .padding(horizontal = 14.dp, vertical = 12.dp)
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth()
        ) {
            // Status icon
            if (isProcessing) {
                val infiniteTransition = rememberInfiniteTransition(label = "toolPulse")
                val pulseAlpha by infiniteTransition.animateFloat(
                    initialValue = 0.4f,
                    targetValue = 1f,
                    animationSpec = infiniteRepeatable(
                        animation = tween(800),
                        repeatMode = RepeatMode.Reverse
                    ),
                    label = "pulseAlpha"
                )
                Box(
                    modifier = Modifier
                        .size(16.dp)
                        .alpha(pulseAlpha)
                        .clip(CircleShape)
                        .background(Accent.copy(alpha = 0.3f)),
                    contentAlignment = Alignment.Center
                ) {
                    Box(
                        modifier = Modifier
                            .size(8.dp)
                            .clip(CircleShape)
                            .background(Accent)
                    )
                }
            } else {
                // Checkmark
                Box(
                    modifier = Modifier
                        .size(16.dp)
                        .clip(CircleShape)
                        .background(Accent.copy(alpha = 0.15f)),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = "✓",
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Bold,
                        color = Accent
                    )
                }
            }

            Spacer(modifier = Modifier.width(10.dp))

            Column(modifier = Modifier.weight(1f)) {
                if (isProcessing) {
                    Text(
                        text = "正在处理",
                        fontSize = 13.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = Accent
                    )
                    Text(
                        text = toolDisplayName(message.toolName),
                        fontSize = 12.sp,
                        color = TextSecondary
                    )
                } else {
                    Text(
                        text = toolDisplayName(message.toolName),
                        fontSize = 13.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = TextPrimary
                    )
                    if (!expanded) {
                        Text(
                            text = message.content,
                            fontSize = 12.sp,
                            color = TextTertiary,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            fontFamily = FontFamily.Monospace
                        )
                    }
                }
            }

            if (!isProcessing) {
                Spacer(modifier = Modifier.width(8.dp))
                Text(
                    text = if (expanded) "▲" else "▼",
                    fontSize = 10.sp,
                    color = TextTertiary
                )
            }
        }

        // Expanded content
        if (expanded && message.content.isNotBlank()) {
            Spacer(modifier = Modifier.height(8.dp))
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(8.dp))
                    .background(Color.Black.copy(alpha = 0.3f))
                    .padding(10.dp)
            ) {
                Text(
                    text = message.content,
                    fontSize = 12.sp,
                    lineHeight = 18.sp,
                    fontFamily = FontFamily.Monospace,
                    color = TextSecondary
                )
            }
        }
    }
}
