import SockJS from 'sockjs-client';
import { Client } from '@stomp/stompjs';

class WebSocketService {
  constructor() {
    this.stompClient = null;
    this.subscribers = [];
    this.subscriptions = {};
    this.isConnected = false;
    this.isConnecting = false;
    this.userId = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectTimeout = null;
    this.backendStatus = {
      websocket: 'disconnected',
      kafka: 'unknown',
      lastError: null,
      lastUpdate: null
    };
  }

  connect(userId) {
    if (this.stompClient?.connected && this.userId === userId) {
      console.log('WebSocket already connected for user:', userId);
      return Promise.resolve();
    }

    this.disconnect();
    this.userId = userId;
    
    return new Promise((resolve, reject) => {
      try {
        console.log('[WebSocket] Connecting WebSocket for user:', userId);
        
        const backendUrl = process.env.REACT_APP_BACKEND_URL || 'http://localhost:8080';
        const token = localStorage.getItem('token');
        
        if (!token) {
          const error = new Error('No authentication token found');
          console.error('[WebSocket] Connection error: No token found');
          reject(error);
          return;
        }
        
        // Create headers object for both SockJS and STOMP
        const headers = {
          'user-id': userId,
          'accept-version': '1.2,1.1,1.0',
          'heart-beat': '4000,4000',
          'Authorization': `Bearer ${token}`
        };
        
        console.log('[WebSocket] Connection headers:', { 
          'user-id': userId,
          'accept-version': '1.2,1.1,1.0',
          'heart-beat': '4000,4000',
          'Authorization': 'Bearer ***'
        });
        
        // Create a new STOMP client with enhanced configuration
        this.stompClient = new Client({
          brokerURL: `${backendUrl.replace('http', 'ws')}/ws`,
          connectHeaders: headers,
          debug: (str) => {
            // Filter out heartbeat messages from logs
            if (!str.includes('>>>') && !str.includes('<<<') && !str.includes('heartbeat')) {
              console.log('[STOMP]', str);
            }
          },
          reconnectDelay: 5000,
          heartbeatIncoming: 4000,
          heartbeatOutgoing: 4000,
          logRawCommunication: true,
          
          // Connection error handling
          onConnect: (frame) => {
            console.log('[WebSocket] STOMP connection established:', frame);
            this.isConnected = true;
            this.reconnectAttempts = 0;
            
            // Subscribe to the user's notification queue
            const subscribed = this.subscribeToNotifications();
            if (subscribed) {
              console.log('[WebSocket] Successfully subscribed to notifications');
              resolve();
            } else {
              reject(new Error('Failed to subscribe to notifications'));
            }
          },
          
          onStompError: (frame) => {
            const errorMessage = frame.headers?.message || 'Unknown STOMP error';
            console.error('[STOMP] Protocol error:', errorMessage);
            
            // Check for Kafka-specific errors
            if (errorMessage.includes('Kafka') || errorMessage.includes('broker')) {
              this.backendStatus.kafka = 'error';
              console.error('[STOMP] Kafka service appears to be down');
            }
            
            this.backendStatus.websocket = 'error';
            this.backendStatus.lastError = errorMessage;
            this.backendStatus.lastUpdate = new Date();
            
            if (reject) {
              reject(new Error(`STOMP error: ${errorMessage}`));
            }
            
            // Only attempt reconnection if this isn't a permanent error
            if (!errorMessage.includes('permanent') && !errorMessage.includes('invalid')) {
              this.handleReconnection();
            } else {
              console.error('[WebSocket] Permanent error, not attempting to reconnect');
              this.isConnecting = false;
            }
          },
          
          onWebSocketClose: (event) => {
            console.log('[WebSocket] Connection closed:', event);
            this.isConnected = false;
            this.handleReconnection();
          },
          
          onWebSocketError: (error) => {
            console.error('[WebSocket] Connection error:', error);
            this.backendStatus.websocket = 'error';
            this.backendStatus.lastError = error.message || 'Connection error';
            this.backendStatus.lastUpdate = new Date();
            
            // Don't reject here to allow the reconnect logic to handle it
            if (reject) {
              reject(error);
            }
            
            if (!this.isConnected) {
              // Only handle reconnection if we're not already connected
              this.handleReconnection();
            }
          },
          
          onDisconnect: (frame) => {
            console.log('[WebSocket] Disconnected', frame);
            this.isConnected = false;
          },
          
          beforeConnect: () => {
            console.log('[WebSocket] Attempting to connect...');
          },
          
          onUnhandledMessage: (message) => {
            console.warn('[WebSocket] Unhandled message:', message);
          }
        });

        // Activate the client
        console.log('[WebSocket] Activating WebSocket connection...');
        this.stompClient.activate();
      } catch (error) {
        console.error('WebSocket connection error:', error);
        reject(error);
      }
    });
  }

  subscribeToNotifications() {
    if (!this.stompClient || !this.stompClient.connected || !this.userId) {
      console.error('[WebSocket] Cannot subscribe: WebSocket not connected');
      return false;
    }

    try {
      console.log('[WebSocket] Setting up subscriptions for user:', this.userId);
      
      // Unsubscribe from any existing subscriptions
      if (this.subscriptions) {
        Object.entries(this.subscriptions).forEach(([key, sub]) => {
          try {
            if (sub) {
              console.log(`[WebSocket] Unsubscribing from ${key}`);
              sub.unsubscribe();
            }
          } catch (error) {
            console.error(`[WebSocket] Error unsubscribing from ${key}:`, error);
          }
        });
      }

      // The backend sends to /user/{userId}/queue/notifications
      const userDestination = `/user/queue/notifications`;
      const broadcastDestination = '/topic/notifications';
      
      console.log('[WebSocket] Subscribing to destinations:', { 
        userDestination, 
        broadcastDestination 
      });
      
      // Subscribe to user-specific notifications
      const userSubscription = this.stompClient.subscribe(
        userDestination,
        (message) => {
          console.log(`[WebSocket] Received message on ${userDestination}`);
          this.handleIncomingMessage(message, 'user');
        },
        { id: `sub-${this.userId}-user` }  // Add subscription ID for better tracking
      );
      
      // Subscribe to broadcast notifications
      const broadcastSubscription = this.stompClient.subscribe(
        broadcastDestination,
        (message) => {
          console.log(`[WebSocket] Received broadcast on ${broadcastDestination}`);
          this.handleIncomingMessage(message, 'broadcast');
        },
        { id: `sub-${this.userId}-broadcast` }  // Add subscription ID for better tracking
      );
      
      // Store subscription references for cleanup
      this.subscriptions = {
        user: userSubscription,
        broadcast: broadcastSubscription
      };
      
      console.log('[WebSocket] Successfully subscribed to WebSocket notifications');
      console.log('[WebSocket] User subscription:', userSubscription?.id || 'failed');
      console.log('[WebSocket] Broadcast subscription:', broadcastSubscription?.id || 'failed');
      
      // Verify subscriptions
      if (!userSubscription || !broadcastSubscription) {
        console.error('[WebSocket] Failed to create one or more subscriptions');
        return false;
      }
      
      return true;
    } catch (error) {
      console.error('[WebSocket] Failed to subscribe to WebSocket:', error);
      return false;
    }
  }
  
  handleIncomingMessage(message, type) {
    try {
      console.log(`[WebSocket] Received ${type} message:`, message);
      
      if (!message || !message.body) {
        console.warn('[WebSocket] Received empty message or missing body');
        return;
      }
      
      try {
        const notification = JSON.parse(message.body);
        console.log('[WebSocket] Parsed notification:', notification);
        
        if (notification) {
          this.notifySubscribers(notification);
        } else {
          console.warn('[WebSocket] Empty notification after parsing');
        }
      } catch (parseError) {
        console.error('[WebSocket] Error parsing message body:', parseError);
        console.error('[WebSocket] Raw message body:', message.body);
      }
    } catch (error) {
      console.error('[WebSocket] Error in handleIncomingMessage:', error);
    }
  }

  handleReconnection() {
    // Prevent multiple reconnection attempts
    if (this.reconnectTimeout) {
      console.log('[WebSocket] Reconnection already in progress');
      return;
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[WebSocket] Max reconnection attempts reached, giving up');
      this.backendStatus.websocket = 'disconnected';
      this.backendStatus.lastError = 'Max reconnection attempts reached';
      this.backendStatus.lastUpdate = new Date();
      this.reconnectAttempts = 0;
      this.isConnecting = false;
      return;
    }

    // Clear any existing timeout
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    // Exponential backoff with jitter
    const baseDelay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    const jitter = Math.random() * 1000; // Add up to 1s jitter
    const delay = Math.floor(baseDelay + jitter);
    
    this.reconnectAttempts++;
    this.backendStatus.websocket = 'reconnecting';
    this.backendStatus.lastUpdate = new Date();
    
    console.log(`[WebSocket] Attempting to reconnect in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
    
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null; // Clear the timeout reference
      
      if (!this.userId) {
        console.warn('[WebSocket] No user ID available for reconnection');
        this.isConnecting = false;
        return;
      }
      
      console.log(`[WebSocket] Reconnecting attempt ${this.reconnectAttempts}...`);
      
      this.connect(this.userId)
        .then(() => {
          const backendStatus = this.getBackendStatus();
          if (backendStatus.isBackendAvailable) {
            console.log('[WebSocket] Successfully reconnected');
            this.backendStatus.websocket = 'connected';
            this.backendStatus.lastError = null;
            this.backendStatus.lastUpdate = new Date();
            this.reconnectAttempts = 0;
          } else {
            console.error('[WebSocket] Backend service is unavailable');
            this.handleReconnection();
          }
        })
        .catch(error => {
          console.error('[WebSocket] Reconnection failed:', error);
          // The reconnection will be handled by the error callbacks
        });
    }, delay);
  }

  subscribe(callback) {
    if (typeof callback !== 'function') {
      console.error('[WebSocket] Subscriber must be a function');
      return () => {}; // Return no-op function for consistency
    }
    
    // Add the callback to subscribers
    this.subscribers.push(callback);
    const callbackId = `sub-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    console.log(`[WebSocket] Added subscriber ${callbackId}, total:`, this.subscribers.length);
    
    // Return unsubscribe function
    return () => {
      const initialLength = this.subscribers.length;
      this.subscribers = this.subscribers.filter(cb => cb !== callback);
      const removedCount = initialLength - this.subscribers.length;
      
      if (removedCount > 0) {
        console.log(`[WebSocket] Removed subscriber ${callbackId}, remaining:`, this.subscribers.length);
      } else {
        console.warn(`[WebSocket] Callback ${callbackId} not found in subscribers`);
      }
    };
  }

  notifySubscribers(notification) {
    if (!notification) {
      console.warn('[WebSocket] Cannot notify subscribers: no notification provided');
      return;
    }
    
    const subscriberCount = this.subscribers.length;
    console.log(`[WebSocket] Notifying ${subscriberCount} subscriber${subscriberCount !== 1 ? 's' : ''}`, 
      { notificationId: notification.id, type: notification.type });
    
    // Create a safe copy of subscribers to prevent issues if array changes during iteration
    const currentSubscribers = [...this.subscribers];
    let errorCount = 0;
    
    currentSubscribers.forEach((callback, index) => {
      try {
        if (typeof callback === 'function') {
          callback(notification);
        } else {
          console.warn(`[WebSocket] Subscriber at index ${index} is not a function`);
        }
      } catch (error) {
        errorCount++;
        console.error(`[WebSocket] Error in subscriber callback at index ${index}:`, error);
      }
    });
    
    if (errorCount > 0) {
      console.warn(`[WebSocket] Completed notifying subscribers with ${errorCount} error${errorCount !== 1 ? 's' : ''}`);
    } else if (subscriberCount > 0) {
      console.log('[WebSocket] Successfully notified all subscribers');
    } else {
      console.log('[WebSocket] No subscribers to notify');
    }
  }

  disconnect() {
    console.log('[WebSocket] Disconnecting WebSocket...');
    
    // Clear any pending reconnection attempts
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    
    // Unsubscribe from all active subscriptions
    if (this.subscriptions) {
      Object.entries(this.subscriptions).forEach(([key, sub]) => {
        try {
          if (sub) {
            console.log(`[WebSocket] Unsubscribing from ${key}`);
            sub.unsubscribe();
          }
        } catch (error) {
          console.error(`[WebSocket] Error unsubscribing from ${key}:`, error);
        }
      });
      this.subscriptions = {};
    }
    
    // Disconnect the STOMP client if it exists
    if (this.stompClient) {
      try {
        if (this.stompClient.connected) {
          console.log('[WebSocket] Deactivating STOMP client');
          this.stompClient.deactivate()
            .then(() => console.log('[WebSocket] STOMP client deactivated'))
            .catch(error => console.error('[WebSocket] Error deactivating STOMP client:', error));
        } else {
          console.log('[WebSocket] STOMP client not connected, skipping deactivation');
        }
      } catch (error) {
        console.error('[WebSocket] Error during WebSocket disconnect:', error);
      } finally {
        this.stompClient = null;
      }
    }
    
    this.isConnected = false;
    this.userId = null;
    console.log('[WebSocket] Disconnected');

    if (this.stompClient) {
      try {
        if (this.stompClient.connected) {
          this.stompClient.deactivate();
        }
        this.stompClient = null;
      } catch (error) {
        console.error('Error disconnecting WebSocket:', error);
      }
    }

    this.isConnected = false;
    this.userId = null;
    this.reconnectAttempts = 0;
    console.log('WebSocket disconnected');
  }
}

// Export a singleton instance
const webSocketService = new WebSocketService();

// Clean up on page unload
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    webSocketService.disconnect();
  });
}

export const connectToWebSocket = (userId) => webSocketService.connect(userId);
export const subscribeToNotifications = (callback) => webSocketService.subscribe(callback);
export const disconnectFromWebSocket = () => webSocketService.disconnect();
