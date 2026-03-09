
package com.example.pi.ui.chat

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import com.example.pi.R
import com.example.pi.ui.chat.components.AiAvatarHeader
import com.example.pi.ui.chat.components.InputBar
import com.example.pi.ui.chat.components.MessageBubble
import com.example.pi.ui.chat.components.TypingIndicator
import com.example.pi.ui.theme.Accent
import com.example.pi.ui.theme.Background
import com.example.pi.ui.theme.TextPrimary
import com.example.pi.ui.theme.TextSecondary
import com.example.pi.ui.theme.TextTertiary
import com.example.pi.ui.settings.SettingsDialog
import java.util.Calendar

@OptIn(ExperimentalLayoutApi::class)
@Preview
@Composable
fun ChatScreen(
    viewModel: ChatViewModel = hiltViewModel()
) {
    var showSettings by remember { mutableStateOf(false) }

    if (showSettings) {
        SettingsDialog(onDismiss = { showSettings = false })
    }

    val isStreaming by viewModel.isStreaming
    val streamingText by viewModel.streamingText
    val pushStreamingText by viewModel.pushStreamingText
    val listState = rememberLazyListState()

    val hasMessages = viewModel.messages.isNotEmpty() || streamingText.isNotEmpty() || pushStreamingText.isNotEmpty()

    val density = LocalDensity.current
    val imeBottom = WindowInsets.ime.getBottom(density)
    LaunchedEffect(imeBottom) {
        if (imeBottom > 0 && viewModel.messages.isNotEmpty()) {
            val extraItems = (if (streamingText.isNotEmpty()) 1 else 0) + (if (pushStreamingText.isNotEmpty()) 1 else 0)
            val targetIndex = viewModel.messages.size + extraItems - 1
            if (targetIndex >= 0) {
                listState.animateScrollToItem(targetIndex)
            }
        }
    }

    LaunchedEffect(viewModel.messages.size, isStreaming, pushStreamingText.isNotEmpty()) {
        if (viewModel.messages.isNotEmpty() || streamingText.isNotEmpty() || pushStreamingText.isNotEmpty()) {
            val extraItems = (if (streamingText.isNotEmpty()) 1 else 0) + (if (pushStreamingText.isNotEmpty()) 1 else 0)
            val targetIndex = viewModel.messages.size + extraItems - 1
            if (targetIndex >= 0) {
                listState.scrollToItem(targetIndex)
            }
        }
    }

    val greeting = remember {
        val hour = Calendar.getInstance().get(Calendar.HOUR_OF_DAY)
        when {
            hour < 6 -> "夜深了"
            hour < 12 -> "早上好"
            hour < 18 -> "下午好"
            else -> "晚上好"
        }
    }

    val suggestions = remember {
        listOf("明早 8 点叫我起床", "帮我记住一件事", "搜一下最近的新闻", "创建一个日历事件")
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Background)
            .navigationBarsPadding()
            .imePadding()
    ) {
        // ===== TOP BAR =====
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .statusBarsPadding()
                .padding(start = 20.dp, end = 20.dp, top = 4.dp, bottom = 4.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            IconButton(
                onClick = { viewModel.clearChat() },
                modifier = Modifier.size(34.dp)
            ) {
                Icon(
                    painter = painterResource(R.drawable.new_chat),
                    contentDescription = "New Chat",
                    tint = TextTertiary,
                    modifier = Modifier.size(20.dp)
                )
            }

            Row(verticalAlignment = Alignment.CenterVertically) {
                // Green dot — matches Electron header
                Box(
                    modifier = Modifier
                        .size(7.dp)
                        .clip(RoundedCornerShape(50))
                        .background(Accent)
                )
                Spacer(modifier = Modifier.size(8.dp))
                Text(
                    text = "Her",
                    fontSize = 15.sp,
                    fontWeight = FontWeight.Bold,
                    color = Color.White
                )
            }

            IconButton(
                onClick = { showSettings = true },
                modifier = Modifier.size(34.dp)
            ) {
                Icon(
                    painter = painterResource(R.drawable.settings),
                    contentDescription = "Settings",
                    tint = TextTertiary,
                    modifier = Modifier.size(20.dp)
                )
            }
        }

        // Divider
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(0.5.dp)
                .background(Color.White.copy(alpha = 0.07f))
        )

        // ===== WELCOME or CHAT =====
        Box(modifier = Modifier.weight(1f)) {
            // Welcome screen
            androidx.compose.animation.AnimatedVisibility(
                visible = !hasMessages,
                enter = fadeIn(),
                exit = fadeOut() + slideOutVertically(targetOffsetY = { -it / 4 })
            ) {
                val infiniteTransition = rememberInfiniteTransition(label = "glow")
                val glowAlpha by infiniteTransition.animateFloat(
                    initialValue = 0.7f,
                    targetValue = 1f,
                    animationSpec = infiniteRepeatable(
                        animation = tween(1500),
                        repeatMode = RepeatMode.Reverse
                    ),
                    label = "glowAlpha"
                )
                val glowScale by infiniteTransition.animateFloat(
                    initialValue = 1f,
                    targetValue = 1.05f,
                    animationSpec = infiniteRepeatable(
                        animation = tween(1500),
                        repeatMode = RepeatMode.Reverse
                    ),
                    label = "glowScale"
                )

                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(horizontal = 32.dp)
                        .padding(bottom = 100.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center
                ) {
                    Icon(
                        painter = painterResource(R.drawable.sparkles),
                        contentDescription = null,
                        tint = Accent,
                        modifier = Modifier
                            .size(48.dp)
                            .alpha(glowAlpha)
                            .scale(glowScale)
                    )

                    Spacer(modifier = Modifier.height(16.dp))

                    Text(
                        text = greeting,
                        fontSize = 22.sp,
                        fontWeight = FontWeight.Bold,
                        color = Color.White
                    )

                    Spacer(modifier = Modifier.height(6.dp))

                    Text(
                        text = "有什么可以帮你的？",
                        fontSize = 14.sp,
                        color = TextSecondary
                    )

                    Spacer(modifier = Modifier.height(24.dp))

                    // Suggestion chips
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        suggestions.forEach { text ->
                            Box(
                                modifier = Modifier
                                    .clip(RoundedCornerShape(20.dp))
                                    .background(Color.White.copy(alpha = 0.05f))
                                    .clickable { viewModel.sendMessage(text) }
                                    .padding(horizontal = 16.dp, vertical = 8.dp)
                            ) {
                                Text(
                                    text = text,
                                    fontSize = 13.sp,
                                    fontWeight = FontWeight.Medium,
                                    color = Accent
                                )
                            }
                        }
                    }
                }
            }

            // Chat messages
            if (hasMessages) {
                LazyColumn(
                    state = listState,
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(horizontal = 20.dp, vertical = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(0.dp)
                ) {
                    items(
                        count = viewModel.messages.size,
                        key = { viewModel.messages[it].id }
                    ) { index ->
                        val message = viewModel.messages[index]
                        val prevRole = if (index > 0) viewModel.messages[index - 1].role else null

                        val topPadding = when {
                            index == 0 -> 0.dp
                            message.role == "tool" && prevRole == "user" -> 16.dp
                            message.role == "tool" && prevRole == "tool" -> 6.dp
                            message.role == "assistant" && prevRole == "tool" -> 6.dp
                            else -> 16.dp
                        }

                        val isFirstToolInGroup = message.role == "tool" && prevRole != "tool"

                        if (message.role == "tool" && isFirstToolInGroup) {
                            AiAvatarHeader(
                                modifier = Modifier.padding(top = topPadding)
                            )
                            MessageBubble(
                                message = message,
                                modifier = Modifier.padding(top = 6.dp),
                                showAvatar = false
                            )
                        } else {
                            val showAvatar = when {
                                message.role == "tool" && isFirstToolInGroup -> true
                                message.role == "assistant" && prevRole == "tool" -> false
                                else -> true
                            }
                            MessageBubble(
                                message = message,
                                modifier = Modifier.padding(top = topPadding),
                                showAvatar = showAvatar
                            )
                        }
                    }

                    if (streamingText.isNotEmpty()) {
                        item {
                            MessageBubble(
                                message = UiMessage(
                                    role = "assistant",
                                    content = streamingText,
                                    isStreaming = true
                                )
                            )
                        }
                    }

                    if (pushStreamingText.isNotEmpty()) {
                        item {
                            MessageBubble(
                                message = UiMessage(
                                    role = "assistant",
                                    content = pushStreamingText,
                                    isStreaming = true
                                )
                            )
                        }
                    }

                    if (isStreaming && streamingText.isEmpty()) {
                        item {
                            TypingIndicator()
                        }
                    }
                }
            }
        }

        // ===== INPUT =====
        InputBar(
            onSend = { text, images -> viewModel.sendMessage(text, images) },
            enabled = !isStreaming
        )
    }
}
