package com.example.pi.ui.navigation

import androidx.compose.runtime.Composable
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import com.example.pi.ui.chat.ChatScreen

@Composable
fun HerNavGraph(navController: NavHostController) {
    NavHost(navController = navController, startDestination = Routes.CHAT) {
        composable(Routes.CHAT) {
            ChatScreen()
        }
    }
}

// Keep old name as alias
@Composable
fun PiNavGraph(navController: NavHostController) = HerNavGraph(navController)
