import React, { useState } from 'react';
import { useLiveFetch } from 'pro_cache';
import axios from 'axios';

interface Todo {
    id: number;
    title: string;
    completed: boolean;
}

interface TodoDetailProps {
    id: number;
    onBack: () => void;
}

const API_URL = 'http://127.0.0.1:3001/api';

export const TodoDetail: React.FC<TodoDetailProps> = ({ id, onBack }) => {
    const { data, loading, error, isRefetchNeeded, refetch, isRefetching } = useLiveFetch<Todo>(
        '/todos/{id}', 
        {
            params: { id },
             // Auto-refetch is DISABLED as per request to test manual updates
            autoRefetch: true,
            // We can also verify cache keys
        }
    );

    const [editTitle, setEditTitle] = useState('');

    const handleUpdate = async () => {
        if (!editTitle) return;
        await axios.put(`${API_URL}/todos/${id}`, { title: editTitle });
        setEditTitle('');
        refetch({ force: false }); // Optimistic or manual refetch with bypass
    };

    if (loading) return <div>Loading Detail...</div>;
    if (error) return <div>Error loading detail</div>;
    if (!data) return <div>No data</div>;

    return (
        <div style={{ padding: 20, border: '1px solid #ccc', margin: 20 }}>
            <button onClick={onBack}>&larr; Back to List</button>
            
            {isRefetchNeeded && (
                <div style={{ background: '#fff3cd', padding: 10, margin: '10px 0', border: '1px solid #ffeeba' }}>
                    <strong>New data available!</strong>
                    <button onClick={() => refetch()} style={{ marginLeft: 10 }}>
                        Update Now
                    </button>
                </div>
            )}

            <h2>Detail: {data.title}</h2>
            <p>Status: {data.completed ? 'Completed' : 'Pending'}</p>
            <p>ID: {data.id}</p>

            <div style={{ marginTop: 20 }}>
                <h4>Update Title (triggers invalidation)</h4>
                <input 
                    value={editTitle}
                    onChange={e => setEditTitle(e.target.value)}
                    placeholder="New title..."
                />
                <button onClick={handleUpdate}>Save</button>
            </div>
            
            {isRefetching && <div style={{ fontSize: '0.8em', color: 'gray' }}>Updating...</div>}
        </div>
    );
};
