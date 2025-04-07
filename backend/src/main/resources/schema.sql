-- Drop table if exists to avoid conflicts
DROP TABLE IF EXISTS authorities;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS user_preferences;

-- Create notifications table
CREATE TABLE notifications (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    source_service VARCHAR(255),
    notification_type VARCHAR(255),
    title VARCHAR(255),
    priority VARCHAR(50),
    content VARCHAR(1000),
    created_at TIMESTAMP,
    read_status VARCHAR(50)
);

-- Create user table
CREATE TABLE users (
    username VARCHAR(50) NOT NULL PRIMARY KEY,
    password VARCHAR(100) NOT NULL,
    enabled BOOLEAN NOT NULL
);

-- Create authorities table
CREATE TABLE authorities (
    username VARCHAR(50) NOT NULL,
    authority VARCHAR(50) NOT NULL,
    CONSTRAINT fk_authorities_users FOREIGN KEY(username) REFERENCES users(username)
);

-- Create user_preferences table
CREATE TABLE user_preferences (
    user_id VARCHAR(255) PRIMARY KEY,
    email_enabled BOOLEAN DEFAULT true,
    websocket_enabled BOOLEAN DEFAULT true,
    minimum_email_priority VARCHAR(50) DEFAULT 'HIGH',
    muted_notification_types VARCHAR(4000)
);

-- Create indexes
CREATE UNIQUE INDEX ix_auth_username ON authorities (username, authority);
CREATE INDEX idx_user_id ON notifications(user_id);
CREATE INDEX idx_notification_type ON notifications(notification_type);
CREATE INDEX idx_priority ON notifications(priority);
CREATE INDEX idx_created_at ON notifications(created_at);
CREATE INDEX idx_read_status ON notifications(read_status);
