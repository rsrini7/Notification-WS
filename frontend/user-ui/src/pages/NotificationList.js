import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Box,
  Typography,
  Paper,
  List,
  ListItem,
  ListItemText,
  ListItemIcon,
  Divider,
  Chip,
  TextField,
  InputAdornment,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Pagination,
  CircularProgress,
  Alert,
  IconButton,
  Tooltip
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import NotificationsActiveIcon from '@mui/icons-material/NotificationsActive';
import DoneAllIcon from '@mui/icons-material/DoneAll';
import DoneIcon from '@mui/icons-material/Done';
import { 
  getNotifications, 
  getUnreadNotifications,
  getNotificationTypes,
  getNotificationsByType,
  searchNotifications,
  markNotificationAsRead,
  subscribeToNotifications,
  countUnreadNotifications,
  connectToWebSocket
} from '../services/notificationService';
import eventBus from '../utils/eventBus';


const NotificationList = ({ user }) => {
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [filter, setFilter] = useState('all'); // 'all', 'unread', or notification type
  const [searchTerm, setSearchTerm] = useState('');
  const [notificationTypes, setNotificationTypes] = useState([]);
  const [markingAsRead, setMarkingAsRead] = useState({});
  const [unreadCount, setUnreadCount] = useState(0);

  const pageSize = 10;

  // Fetch notifications with proper error handling and loading states
  const fetchNotifications = useCallback(async () => {
    if (!user?.id) return;

    try {
      setLoading(true);
      setError('');

      let response;
      if (searchTerm) {
        response = await searchNotifications(user.id, searchTerm, page - 1, pageSize);
      } else if (filter === 'all') {
        response = await getNotifications(user.id, page - 1, pageSize);
      } else if (filter === 'unread') {
        response = await getUnreadNotifications(user.id, page - 1, pageSize);
      } else {
        response = await getNotificationsByType(user.id, filter, page - 1, pageSize);
      }

      setNotifications(response.content);
      setTotalPages(response.totalPages);
      
      // Update unread count if we're on the first page
      if (page === 1) {
        const count = await countUnreadNotifications(user.id);
        setUnreadCount(count);
      }
    } catch (err) {
      console.error('Error fetching notifications:', err);
      setError('Failed to load notifications. Please try again later.');
    } finally {
      setLoading(false);
    }
  }, [user?.id, filter, searchTerm, page, pageSize]);

  useEffect(() => {
    fetchNotifications();
    
  }, [page, filter, fetchNotifications]);

  // Reset to page 1 when filter or search term changes
  useEffect(() => {
    const fetchTypes = async () => {
      const typesData = await getNotificationTypes();
      setNotificationTypes(typesData);
    };

    fetchTypes();
    setPage(1);
  }, [filter, searchTerm]);

  // Ref for state values needed in stable callbacks that depend on filter, searchTerm, page
  const dynamicStatesRef = useRef({ filter, searchTerm, page });

  useEffect(() => {
    dynamicStatesRef.current = { filter, searchTerm, page };
  }, [filter, searchTerm, page]);

  // Handle new notifications from WebSocket
  const handleNewNotificationCb = useCallback((newNotification) => {
    if (!newNotification || !user?.id) return;

    console.log('Processing new notification (stable callback):', newNotification);
    const { filter: currentFilter, searchTerm: currentSearchTerm, page: currentPage } = dynamicStatesRef.current;

    // Update unread count for new UNREAD notifications
    if (newNotification.readStatus === 'UNREAD') {
      setUnreadCount(prev => prev + 1);
    }

    // Check if we should add this notification to the current view
    const shouldAddNotification = () => {
      if (currentSearchTerm) {
        // If there's an active search, check if it matches
        const searchLower = currentSearchTerm.toLowerCase();
        return (newNotification.content?.toLowerCase().includes(searchLower) ||
                newNotification.title?.toLowerCase().includes(searchLower));
      }

      // No active search, check filters
      if (currentFilter === 'all') return true;
      if (currentFilter === 'unread') return newNotification.readStatus === 'UNREAD';
      return currentFilter === newNotification.notificationType;
    };

    if (shouldAddNotification()) {
      setNotifications(prevNotifications => {
        // Check if notification already exists to prevent duplicates
        const exists = prevNotifications.some(n => n.id === newNotification.id);
        if (!exists) {
          // If we're on the first page, add to the top and maintain page size
          if (currentPage === 1) {
            // pageSize is a const, available in this scope
            return [newNotification, ...prevNotifications.slice(0, pageSize - 1)];
          }
          // If not on page 1, don't add to the current list.
          // The unread count is updated, and data will be fetched if user navigates to page 1.
          return prevNotifications;
        }
        return prevNotifications;
      });
    }
  }, [user?.id]); // pageSize is a const, so not a dependency.

  // Set up WebSocket connection and subscription
  useEffect(() => {
    if (!user?.id) return;

    let isMounted = true;
    let unsubscribeFromWs = null;
    let reconnectTimeout = null;

    const initializeWebSocket = async () => {
      if (!isMounted) return;
      
      try {
        console.log('Initializing WebSocket connection for user:', user.id);
        
        // Connect to WebSocket
        await connectToWebSocket(user.id);
        
        // Subscribe to WebSocket updates
        unsubscribeFromWs = subscribeToNotifications(handleNewNotificationCb);
        console.log('Successfully connected and subscribed to WebSocket');
        
        // Initial fetch of notifications
        await fetchNotifications();
        
      } catch (error) {
        console.error('WebSocket connection error:', error);
        
        // Retry connection after a delay with exponential backoff
        if (isMounted) {
          const delay = 5000; // Start with 5 seconds
          console.log(`Reconnecting in ${delay}ms...`);
          
          reconnectTimeout = setTimeout(() => {
            if (isMounted) initializeWebSocket();
          }, delay);
        }
      }
    };
    
    initializeWebSocket();
    
    // Cleanup on unmount
    return () => {
      isMounted = false;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (unsubscribeFromWs) {
        console.log('Cleaning up WebSocket subscription');
        unsubscribeFromWs();
      }
      // Don't disconnect here as other components might be using the WebSocket
    };
  }, [user?.id, handleNewNotificationCb, fetchNotifications]);

  // Fetch notifications when filter or search term changes
  useEffect(() => {
    if (user?.id) {
      fetchNotifications();
    }
  }, [fetchNotifications, user?.id, filter, searchTerm]);

  const handlePageChange = (event, value) => {
    setPage(value);
  };

  const handleFilterChange = (event) => {
    setFilter(event.target.value);
    setPage(1); // Reset to first page when changing filters
  };

  const handleMarkAsRead = async (notificationId) => {
    try {
      setMarkingAsRead(prev => ({ ...prev, [notificationId]: true }));
      await markNotificationAsRead(notificationId, user.id);
      
      // Update local state
      setNotifications(prev => 
        prev.map(notification => 
          notification.id === notificationId 
            ? { ...notification, readStatus: 'READ' } 
            : notification
        )
      );
      
      // Update unread count
      setUnreadCount(prev => Math.max(0, prev - 1));
      eventBus.emit('notificationsUpdated');
    } catch (err) {
      console.error('Error marking notification as read:', err);
      setError('Failed to mark notification as read. Please try again.');
    } finally {
      setMarkingAsRead(prev => ({ ...prev, [notificationId]: false }));
    }
  };

  const handleSearch = (event) => {
    event.preventDefault();
    fetchNotifications();
  };

  return (
    <Box sx={{ flexGrow: 1, p: 3 }}>
      <Typography variant="h4" gutterBottom>
        Notifications - Unread: {unreadCount}
      </Typography>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      <Paper sx={{ p: 2, mb: 3 }}>
        <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, gap: 2, mb: 2 }}>
          <FormControl variant="outlined" sx={{ minWidth: 200 }}>
            <InputLabel id="filter-label">Filter</InputLabel>
            <Select
              labelId="filter-label"
              id="filter-select"
              value={filter}
              onChange={handleFilterChange}
              label="Filter"
            >
              <MenuItem value="all">All Notifications</MenuItem>
              <MenuItem value="unread">Unread Only</MenuItem>
              <Divider />
              {notificationTypes.map(type => (
                <MenuItem key={type} value={type}>{type}</MenuItem>
              ))}
            </Select>
          </FormControl>

          <Box component="form" onSubmit={handleSearch} sx={{ display: 'flex', flexGrow: 1 }}>
            <TextField
              fullWidth
              variant="outlined"
              placeholder="Search notifications..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon />
                  </InputAdornment>
                ),
              }}
            />
          </Box>
        </Box>
      </Paper>

      {loading ? (
        <Box display="flex" justifyContent="center" sx={{ my: 4 }}>
          <CircularProgress />
        </Box>
      ) : notifications.length > 0 ? (
        <Paper>
          <List>
            {notifications.map((notification, index) => (
              <React.Fragment key={notification.id}>
                {index > 0 && <Divider />}
                <ListItem 
                  alignItems="flex-start"
                  className={`notification-item ${notification.read ? 'notification-read' : 'notification-unread'}`}
                  secondaryAction={
                    notification.readStatus !== 'READ' && (
                      <Tooltip title="Mark as read">
                        <IconButton 
                          edge="end" 
                          aria-label="mark as read"
                          onClick={() => handleMarkAsRead(notification.id)}
                          disabled={markingAsRead[notification.id]}
                        >
                          {markingAsRead[notification.id] ? 
                            <CircularProgress size={24} /> : 
                            <DoneAllIcon />}
                        </IconButton>
                      </Tooltip>
                    )
                  }
                >
                  <ListItemIcon>
                    {notification.readStatus === 'READ' ? 
                      <DoneIcon color="disabled" /> : 
                      <NotificationsActiveIcon color="primary" />}
                  </ListItemIcon>
                  <ListItemText
                    sx={ notification.readStatus === 'READ' ? { opacity: 0.6 } : {} }
                    primary={
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Typography variant="subtitle1" component="span">
                          {notification.content}
                        </Typography>
                        <Chip 
                          label={notification.notificationType} 
                          size="small" 
                          color={notification.readStatus === 'READ' ? "default" : "primary"}
                          variant={notification.readStatus === 'READ' ? "outlined" : "filled"}
                        />
                      </Box>
                    }
                    secondary={
                      <React.Fragment>
                        <Typography
                          sx={{ display: 'block' }}
                          component="span"
                          variant="body2"
                          color="text.secondary"
                        >
                          From: {notification.sourceService}
                        </Typography>
                        <Typography
                          component="span"
                          variant="caption"
                          color="text.secondary"
                        >
                          {new Date(notification.createdAt).toLocaleString()}
                        </Typography>
                      </React.Fragment>
                    }
                  />
                </ListItem>
              </React.Fragment>
            ))}
          </List>
          <Box sx={{ display: 'flex', justifyContent: 'center', p: 2 }}>
            <Pagination 
              count={totalPages} 
              page={page} 
              onChange={handlePageChange} 
              color="primary" 
            />
          </Box>
        </Paper>
      ) : (
        <Paper sx={{ p: 3, textAlign: 'center' }}>
          <Typography variant="body1">
            {searchTerm ? 'No notifications match your search' : 'No notifications found'}
          </Typography>
        </Paper>
      )}
    </Box>
  );
};

export default NotificationList;