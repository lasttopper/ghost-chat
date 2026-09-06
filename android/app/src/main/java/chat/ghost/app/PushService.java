package chat.ghost.app;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

/**
 * Receives FCM data messages. Because the server sends DATA-only payloads,
 * onMessageReceived runs even when the app was frozen or killed - Android
 * starts the process to deliver it - so notifications arrive regardless of
 * the app's state.
 */
public class PushService extends FirebaseMessagingService {

    @Override
    public void onMessageReceived(RemoteMessage message) {
        Map<String, String> data = message.getData();
        String title = data.get("title");
        String body = data.get("body");
        if (title == null || title.isEmpty()) title = "Ghost Chat";
        String tag = data.get("conv");
        String image = data.get("image");
        if (image != null && image.startsWith("https://i.ibb.co/")) {
            // onMessageReceived runs on a background thread, so the image
            // download inside showImage is safe here.
            Notifications.showImage(this, title, body == null ? "" : body, tag, image);
        } else {
            Notifications.show(this, title, body == null ? "" : body, tag);
        }
    }

    @Override
    public void onNewToken(String token) {
        // Forward to the page when it's alive so the server registry updates;
        // if the app is closed the page re-registers on its next launch.
        MainActivity.pushTokenRefreshed(token);
    }
}
