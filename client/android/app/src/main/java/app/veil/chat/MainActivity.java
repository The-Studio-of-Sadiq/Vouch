package app.veil.chat;

import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // FLAG_SECURE makes the OS refuse screenshots and screen recordings of
        // this window, shows it black in casting/mirroring, and blanks the
        // app's thumbnail in the recent-apps switcher. Set before the WebView
        // draws anything so no frame is ever capturable.
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        super.onCreate(savedInstanceState);
    }
}
